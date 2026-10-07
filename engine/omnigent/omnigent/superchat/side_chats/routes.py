"""``POST /sessions/{id}/side_chats``: open a Side Chat from its Super Chat.

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
from typing import Any

import httpx
from fastapi import APIRouter, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_EDIT, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import (
    require_access_and_level as _require_access_and_level,
)
from omnigent.server.routes._errors import session_not_found as _session_not_found
from omnigent.server.schemas import SideChatOpenRequest, SideChatOpenResponse
from omnigent.stores import ConversationStore
from omnigent.stores.conversation_store import (
    SIDE_CHAT_PARENT_LABEL_KEY,
    SIDE_CHAT_START_LABEL_KEY,
)
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat.family.signals import notify_chats_changed
from omnigent.superchat.side_chats.chats import (
    SIDE_CHAT_START_WITH_CONTEXT,
    build_side_chat_blank_create_body,
    build_side_chat_fork_body,
    refuse_side_chat_open,
)

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
        user message.

        :param session_id: The Super Chat to branch the Side Chat from.
        :param body: ``start`` (required), optional ``title`` /
            ``first_message``.
        :returns: ``{conversation_id, title, start}``.
        :raises OmnigentError: 404 if *session_id* does not exist; 403 if
            it is a Side Chat or a Sub-agent, or isn't in superside-chat
            mode; whatever the fork/create/message step raises on
            failure.
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

        refusal = refuse_side_chat_open(
            labels=caller.labels,
            kind=caller.kind,
            parent_session_id=caller.parent_conversation_id,
        )
        if refusal is not None:
            raise OmnigentError(refusal, code=ErrorCode.FORBIDDEN)

        if body.start == SIDE_CHAT_START_WITH_CONTEXT:
            create_resp = await _internal_call(
                request,
                "POST",
                f"/sessions/{session_id}/fork",
                build_side_chat_fork_body(body.title),
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

        await asyncio.to_thread(
            conversation_store.set_labels,
            new_id,
            {SIDE_CHAT_START_LABEL_KEY: body.start, SIDE_CHAT_PARENT_LABEL_KEY: session_id},
        )
        notify_chats_changed(session_id)

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
        if body.first_message:
            msg_resp = await _internal_call(
                request,
                "POST",
                f"/sessions/{new_id}/events",
                {
                    "type": "message",
                    "data": {
                        "role": "user",
                        "content": [{"type": "input_text", "text": body.first_message}],
                    },
                },
            )
            # The Side Chat already exists; report the failed message instead of
            # erroring, so the caller doesn't retry into a duplicate chat.
            if msg_resp.status_code >= 400:
                _logger.warning(
                    "side_chat_open: first message not delivered to %s (%s)",
                    new_id,
                    msg_resp.status_code,
                )
                first_message_error = f"first message not delivered ({msg_resp.status_code})"

        return SideChatOpenResponse(
            conversation_id=new_id,
            title=new_conv.get("title"),
            start=body.start,
            first_message_error=first_message_error,
        )
