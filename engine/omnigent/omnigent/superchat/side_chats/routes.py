"""``POST /sessions/{id}/side_chats``: open a Side Chat (or a Fork) from its Super Chat, and
``POST /sessions/{id}/add_to_conversation``: add a Fork's summary back under its anchor.

The one implementation behind both the web app's "+ New side chat" and the
model-facing ``side_chat_open`` tool (``omnigent.superchat.side_chats.
handlers``, which calls this route instead of forking /
creating / binding the pieces itself). See ``rollover/SUPERSIDE-CHAT.md``
and ``omnigent/superchat/side_chats/chats.py`` for the eligibility rule and the two
``start`` modes.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

import httpx
from fastapi import APIRouter, Request

from omnigent.context.rollover import _MID_TURN_LIVE_STATUSES
from omnigent.context.side_chat_seeds import seed_pending, wait_for_seed
from omnigent.entities import Conversation
from omnigent.entities.conversation import synthesize_conversation_title
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.background_session_titles import (
    background_session_titles_enabled,
    prepare_background_session_title,
)
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.server.routes._sessions.common import get_server_runner_router
from omnigent.server.routes._sessions.helpers import _forward_session_change_to_runner
from omnigent.server.schemas import (
    ForkAddRequest,
    SessionEventInput,
    SideChatOpenRequest,
    SideChatOpenResponse,
)
from omnigent.stores import ConversationStore
from omnigent.stores.conversation_store import (
    SIDE_CHAT_PARENT_LABEL_KEY,
    SIDE_CHAT_START_LABEL_KEY,
    side_chat_parent_id,
)
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat.family.signals import notify_chats_changed, notify_message_done
from omnigent.superchat.lineage import FORK_ANCHOR_LABEL_KEY, FORK_PARENT_LABEL_KEY
from omnigent.superchat.side_chats.chats import (
    SIDE_CHAT_START_WITH_CONTEXT,
    build_side_chat_blank_create_body,
    build_side_chat_fork_body,
    refuse_side_chat_open,
)
from omnigent.superchat.side_chats.forks import (
    FORK_ADDED_LABEL_KEYS,
    FORK_SUMMARY_INSTRUCTIONS,
    STATE_ADDED,
    STATE_ARCHIVED,
    check_fork_open,
    fork_anchor_id,
    fork_parent_id,
    store_added_summary,
    summary_prompt,
)
from omnigent.superchat.titles import tidy_request_title

_logger = logging.getLogger(__name__)

# Headers an internal self-call must not replay verbatim: httpx derives
# content-length/content-type from its own ``json=`` body, and host/connection
# are transport-level, not application identity.
_DROPPED_FORWARD_HEADERS = frozenset({"content-length", "content-type", "host", "connection"})


async def _internal_call(
    request: Request, method: str, path: str, json_body: dict[str, Any]
) -> httpx.Response:
    """Call one of this server's own ``/v1`` routes, in-process.

    Reuses the real route handler — auth, the CSRF origin guard, every
    side effect (ownership grant, announcing the new session, the runner
    notify) — instead of re-implementing it here, by going through the
    same ASGI app the current request already matched against. No socket
    is opened; this is the same technique the test suite's own ``client``
    fixture uses to drive the app (``httpx.ASGITransport``). The caller's
    own auth headers ride along so the sub-call authorizes as the same
    user.
    """
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _DROPPED_FORWARD_HEADERS
    }
    transport = httpx.ASGITransport(app=request.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://internal/v1") as client:
        return await client.request(method, path, json=json_body, headers=headers)


def register_side_chats_routes(
    router: APIRouter,
    *,
    conversation_store: ConversationStore,
    auth_provider: AuthProvider | None = None,
    permission_store: PermissionStore | None = None,
) -> None:
    """Register ``POST /sessions/{session_id}/side_chats``."""

    @router.post(
        "/sessions/{session_id}/side_chats",
        status_code=201,
        response_model=None,
        responses={201: {"model": SideChatOpenResponse}},
    )
    async def open_side_chat(
        request: Request,
        session_id: str,
        body: SideChatOpenRequest,
    ) -> SideChatOpenResponse:
        """
        Open a Side Chat branched from a Super Chat.

        Does exactly what the ``side_chat_open`` tool does today: refuses
        unless *session_id* is itself a superside-chat Super Chat (never a
        Side Chat, never a Sub-agent — :func:`refuse_side_chat_open`);
        ``start: "with_context"`` forks it with a seeded checkpoint
        (``POST /sessions/{id}/fork``, ``side_chat: true``); ``"blank"``
        creates a fresh top-level session carrying the discovery labels
        (``POST /sessions``). Either way the new Side Chat is stamped with
        how it started, bound to the Super Chat's host (best-effort, as
        ``POST /hosts/{host_id}/runners`` already is for an unbound fork),
        and — when ``first_message`` is given — sent that as its first
        user message. A ``with_context`` chat answers before its seed is written
        (``omnigent/context/side_chat_seeds.py``): its first message goes out once
        the seed lands. An untitled chat is titled from that message at once, and
        by the model in the background once it is delivered.

        With ``anchor_item_id`` it opens a Fork (ADR 0010): *session_id* may
        then also be a fork of the Super Chat (once), the seed ends at the
        anchor, and the anchor and its chat are stamped on the new Side Chat
        (``omnigent/superchat/side_chats/forks.py``).

        :param session_id: The Super Chat to branch the Side Chat from (or,
            for a fork, the chat holding the anchor).
        :param body: ``start`` (required), optional ``title`` /
            ``first_message`` / ``anchor_item_id``.
        :returns: ``{conversation_id, title, start, anchor_item_id, parent_id}``.
        :raises OmnigentError: 404 if *session_id* does not exist; 403 if
            it is a Side Chat (an anchorless one, for a fork) or a Sub-agent,
            or isn't in superside-chat mode; 422 ``fork_too_deep`` /
            ``fork_anchor_invalid`` for a fork; whatever the
            fork/create/message step raises on failure.
        """
        user_id = _get_user_id(request, auth_provider)
        access = await _require_access_and_level(
            user_id, session_id, LEVEL_EDIT, permission_store, conversation_store
        )
        caller = access.conversation
        if caller is None:
            caller = await asyncio.to_thread(conversation_store.get_conversation, session_id)
            if caller is None:
                raise _session_not_found()

        anchor = None
        if body.anchor_item_id is not None:
            if body.start != SIDE_CHAT_START_WITH_CONTEXT:
                raise OmnigentError("A fork starts with_context", code=ErrorCode.INVALID_INPUT)
            anchor = await asyncio.to_thread(
                check_fork_open, conversation_store, caller, body.anchor_item_id
            )
        else:
            refusal = refuse_side_chat_open(
                labels=caller.labels,
                kind=caller.kind,
                parent_session_id=caller.parent_conversation_id,
            )
            if refusal is not None:
                raise OmnigentError(refusal, code=ErrorCode.FORBIDDEN)
        # A fork of a fork still belongs to the Super Chat's family.
        root_id = side_chat_parent_id(caller.labels) or session_id

        if body.start == SIDE_CHAT_START_WITH_CONTEXT:
            create_resp = await _internal_call(
                request,
                "POST",
                f"/sessions/{session_id}/fork",
                build_side_chat_fork_body(body.title, anchor=anchor),
            )
        else:
            agent_id = caller.agent_id
            if not isinstance(agent_id, str) or not agent_id:
                raise OmnigentError(
                    "side_chat_open: caller session has no agent binding",
                    code=ErrorCode.INVALID_INPUT,
                )
            create_resp = await _internal_call(
                request,
                "POST",
                "/sessions",
                build_side_chat_blank_create_body(
                    agent_id=agent_id,
                    title=body.title,
                ),
            )
        if create_resp.status_code != 201:
            raise OmnigentError(
                f"side_chat_open {body.start} failed: "
                f"{create_resp.status_code} {create_resp.text}",
                code=ErrorCode.INTERNAL_ERROR,
            )
        new_conv = create_resp.json()
        new_id = new_conv["id"]

        labels = {SIDE_CHAT_START_LABEL_KEY: body.start, SIDE_CHAT_PARENT_LABEL_KEY: root_id}
        if anchor is not None:
            labels |= {FORK_ANCHOR_LABEL_KEY: anchor.id, FORK_PARENT_LABEL_KEY: session_id}
        await asyncio.to_thread(conversation_store.set_labels, new_id, labels)
        # A fork of a fork copies its parent's labels: not its "added to the Conversation" state.
        for key in FORK_ADDED_LABEL_KEYS & caller.labels.keys():
            await asyncio.to_thread(conversation_store.delete_label, new_id, key)
        title, start_title = new_conv.get("title"), None
        if body.first_message and not title:
            title, start_title = await _title_from_first_message(
                request, conversation_store, new_id, body.first_message
            )
        notify_chats_changed(root_id)

        host_id = caller.host_id
        workspace = caller.workspace
        if isinstance(host_id, str) and host_id and isinstance(workspace, str) and workspace:
            try:
                await _internal_call(
                    request,
                    "POST",
                    f"/hosts/{host_id}/runners",
                    {"session_id": new_id, "workspace": workspace},
                )
            except httpx.HTTPError:
                # Best-effort: an unbound Side Chat behaves like an unbound
                # fork made through the web UI — the caller can bind it later.
                _logger.warning(
                    "side_chat_open: failed to bind host for %s", new_id, exc_info=True
                )

        first_message_error: str | None = None
        first_message_error_code: str | None = None
        if body.first_message and seed_pending(new_id):
            # The message waits for the seed (tens of seconds): send it after answering, so
            # the new chat opens at once. A failure then shows as an unanswered message.
            _send_in_background(
                request, conversation_store, new_id, body.first_message, root_id, start_title
            )
        elif body.first_message:
            # The Side Chat already exists; report the failed message instead of
            # erroring, so the caller doesn't retry into a duplicate chat.
            first_message_error, first_message_error_code = await _deliver_first_message(
                request, conversation_store, new_id, body.first_message
            )
            if first_message_error is None and start_title is not None:
                start_title()

        return SideChatOpenResponse(
            conversation_id=new_id,
            title=title,
            start=body.start,
            first_message_error=first_message_error,
            first_message_error_code=first_message_error_code,
            anchor_item_id=anchor.id if anchor is not None else None,
            parent_id=session_id if anchor is not None else None,
        )

    @router.post("/sessions/{session_id}/add_to_conversation", response_model=None)
    async def add_fork_to_conversation(
        request: Request,
        session_id: str,
        body: ForkAddRequest | None = None,
    ) -> dict[str, Any]:
        """
        Add a fork's one-line summary back under its anchor (ADR 0010).

        Stores the summary on the fork (its state becomes ``added``; the transcript draws a
        ``fork_summary`` block under the anchor) and appends a system notice to the chat
        holding the anchor, so the Muse reads it. Asking again with the same summary changes
        nothing; a new summary replaces it.

        :param session_id: The fork.
        :param body: Optional ``summary``; without one the engine writes it from the fork.
        :returns: ``{"fork_id", "session_id", "anchor_item_id", "item_id", "title",
            "summary", "state"}``: ``session_id`` is the chat holding the anchor, ``item_id``
            the notice the Muse reads.
        :raises OmnigentError: 404 if the fork does not exist; 403 without EDIT on the fork
            and its parent chat; 422 ``not_a_fork`` for any other chat; 400 when no summary
            was given and the fork has nothing to summarise yet.
        """
        user_id = _get_user_id(request, auth_provider)
        access = await _require_access_and_level(
            user_id, session_id, LEVEL_EDIT, permission_store, conversation_store
        )
        fork = access.conversation or await asyncio.to_thread(
            conversation_store.get_conversation, session_id
        )
        if fork is None:
            raise _session_not_found()
        parent_id = fork_parent_id(fork.labels)
        if parent_id is None:
            raise OmnigentError("This chat is not a fork", code=ErrorCode.NOT_A_FORK)
        parent_access = await _require_access_and_level(
            user_id, parent_id, LEVEL_EDIT, permission_store, conversation_store
        )
        parent = parent_access.conversation or await asyncio.to_thread(
            conversation_store.get_conversation, parent_id
        )
        if parent is None:
            raise _session_not_found()

        summary = " ".join((body.summary if body and body.summary else "").split())
        if not summary:
            summary = await _write_summary(request, conversation_store, fork)
        notice, changed = await asyncio.to_thread(
            store_added_summary, conversation_store, fork, summary, created_by=user_id
        )
        if changed and notice is not None:
            root_id = side_chat_parent_id(fork.labels) or parent_id
            notify_chats_changed(root_id)
            notify_message_done(parent_id, notice.id)
            if parent.live_status not in _MID_TURN_LIVE_STATUSES:
                # Drop the runner's warm history so the next turn reloads it with the notice;
                # mid-turn, the notice is read at the next cold start instead.
                await _forward_session_change_to_runner(
                    parent_id, get_server_runner_router(), {"type": "context_reset"}
                )
        return {
            "fork_id": fork.id,
            "session_id": parent_id,
            "anchor_item_id": fork_anchor_id(fork.labels),
            "item_id": notice.id if notice is not None else None,
            "title": fork.title,
            "summary": summary,
            "state": STATE_ARCHIVED if fork.archived else STATE_ADDED,
        }


async def _write_summary(
    request: Request, conversation_store: ConversationStore, fork: Conversation
) -> str:
    """A one-line summary of *fork*: model-written when its runner answers, else its gist."""
    prompt, fallback = await asyncio.to_thread(summary_prompt, conversation_store, fork)
    if not prompt:
        raise OmnigentError("The fork has nothing to add yet", code=ErrorCode.INVALID_INPUT)
    coordinator = getattr(request.app.state, "background_title_coordinator", None)
    line = (
        await coordinator.write_line(
            conversation=fork, prompt=prompt, instructions=FORK_SUMMARY_INSTRUCTIONS
        )
        if coordinator is not None
        else None
    )
    summary = line or fallback or tidy_request_title(prompt.split("\n", 1)[0].partition(": ")[2])
    if not summary:
        raise OmnigentError("The fork has nothing to add yet", code=ErrorCode.INVALID_INPUT)
    return summary


async def _title_from_first_message(
    request: Request, conv_store: ConversationStore, chat_id: str, text: str
) -> tuple[str | None, Callable[[], None] | None]:
    """Title an untitled new chat from its first message now, as the events route would.

    The short model-written title is the events route's own background title too, but it
    must start only once the message is delivered (the chat's runner writes it).

    :returns: ``(title, start)``: the title set now, and what starts the background title
        (``None`` when titles are off or the chat is not titled from its message).
    """
    conv = await asyncio.to_thread(conv_store.get_conversation, chat_id)
    content = [{"type": "input_text", "text": text}]
    seed_title = synthesize_conversation_title(content)
    if conv is None or conv.title is not None or seed_title is None:
        return (conv.title if conv is not None else None), None
    pending = prepare_background_session_title(
        coordinator=getattr(request.app.state, "background_title_coordinator", None),
        conversation=conv,
        event=SessionEventInput(type="message", data={"role": "user", "content": content}),
        enabled=background_session_titles_enabled(request.headers),
    )
    await asyncio.to_thread(conv_store.update_conversation, chat_id, title=seed_title)
    if pending is None:
        return seed_title, None
    return seed_title, lambda: pending.schedule(expected_seed_title=seed_title)


#: First messages being sent after their chat's open request answered (kept so none is
#: garbage-collected mid-flight).
_background_sends: set[asyncio.Task[None]] = set()


def _send_in_background(
    request: Request,
    conv_store: ConversationStore,
    chat_id: str,
    text: str,
    root_id: str,
    start_title: Callable[[], None] | None,
) -> None:
    """Deliver a new chat's first message once its seed lands, without holding up the open."""

    async def send() -> None:
        await wait_for_seed(chat_id)  # the events route waits too; no need to hold its slot
        error, _ = await _deliver_first_message(request, conv_store, chat_id, text)
        if error is None and start_title is not None:
            start_title()
        notify_chats_changed(root_id)  # its live flag changed with the message

    task = asyncio.create_task(send(), name=f"side-chat-first-message-{chat_id}")
    _background_sends.add(task)
    task.add_done_callback(_background_sends.discard)


#: Statuses worth one more try: a runner still starting, a conflict, a server blip.
_RETRYABLE_STATUSES = frozenset({409, 429, 500, 502, 503, 504})
#: Wait before the one retry (patched to 0 in tests).
FIRST_MESSAGE_RETRY_DELAY_S = 1.5
#: Newest items checked for an already-stored first message before retrying.
_STORED_CHECK_ITEMS = 20


def _error_code(resp: httpx.Response) -> str | None:
    try:
        error = resp.json().get("error")
    except ValueError:
        return None
    code = error.get("code") if isinstance(error, dict) else None
    return code if isinstance(code, str) else None


def _first_message_stored(conv_store: ConversationStore, chat_id: str, text: str) -> bool:
    """Whether the chat already holds *text* as a user message of its own (after its seed)."""
    from omnigent.superchat.transcript.blocks import item_text

    page = conv_store.list_items(chat_id, limit=_STORED_CHECK_ITEMS, order="desc")
    for item in page.data:
        flat = item.to_api_dict()
        if flat.get("type") == "compaction":
            return False  # reached the seed: everything older is copied context
        if (
            flat.get("type") == "message"
            and flat.get("role") == "user"
            and item_text(flat) == text.strip()
        ):
            return True
    return False


async def _deliver_first_message(
    request: Request, conv_store: ConversationStore, chat_id: str, text: str
) -> tuple[str | None, str | None]:
    """Post the first message, retrying once after a retryable failure.

    The events route stores a message before forwarding it, so a failed forward can leave it
    stored: the retry is skipped then (it would post it twice) and the failure is reported.

    :returns: ``(None, None)`` when delivered, else ``(error, code)``.
    """
    status: int | None = None
    code: str | None = None
    for attempt in range(2):
        try:
            resp = await _internal_call(
                request,
                "POST",
                f"/sessions/{chat_id}/events",
                {
                    "type": "message",
                    "data": {"role": "user", "content": [{"type": "input_text", "text": text}]},
                },
            )
        except httpx.HTTPError:
            status, code = None, "transport_error"
        except Exception:  # noqa: BLE001 — the in-process route raised; the chat exists anyway
            _logger.warning("side_chat_open: first message raised for %s", chat_id, exc_info=True)
            status, code = None, "internal_error"
        else:
            if resp.status_code < 400:
                return None, None
            status, code = resp.status_code, _error_code(resp)
        if attempt or (status is not None and status not in _RETRYABLE_STATUSES):
            break
        if await asyncio.to_thread(_first_message_stored, conv_store, chat_id, text):
            break
        await asyncio.sleep(FIRST_MESSAGE_RETRY_DELAY_S)
    _logger.warning(
        "side_chat_open: first message not delivered to %s (%s, %s)", chat_id, status, code
    )
    return f"first message not delivered ({status or code})", code or "internal_error"
