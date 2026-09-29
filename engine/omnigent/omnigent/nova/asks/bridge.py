"""Bridges Nova Asks to Omnigent's own elicitation and session-event machinery.

An Ask that started life as an Omnigent elicitation (a policy approval, an
MCP form, a claude-native permission prompt) needs two things a plain Ask
row cannot provide on its own: catching the request the moment it fires,
and — once the person answers — putting the verdict back where the parked
agent turn is waiting for it. Both directions reach into Omnigent runtime
internals that Nova does not own, so they live here rather than in
``service.py``, which stays pure and testable without a running server.

Both entry points below reach their dependencies (the Ask store, the
conversation store) through the same ambient process-wide accessors built-in
tools already use (``omnigent.runtime.get_conversation_store``, mirrored
here as :func:`omnigent.nova.asks._runtime_store`) — there is no request,
and no ``NovaDeps``, at either call site. This needs exactly one guarded
call site outside ``nova/asks/``:

``on_session_event()`` — called from the single chokepoint every
server-emitted SSE event passes through
(:func:`omnigent.runtime.session_stream.publish`), right next to the
existing ``pending_elicitations.record_publish`` call it mirrors. See that
call site for how failures there are contained.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.nova import asks as _asks
from omnigent.nova._shared import private_actor
from omnigent.nova.asks.entities import Ask, AskAction, AskKind
from omnigent.nova.asks.service import AskService

_logger = logging.getLogger(__name__)

# The event type session_stream.publish forwards here; matches
# pending_elicitations' own literal (that module has no public constant for
# it, so this mirrors its string exactly).
_ELICITATION_REQUEST_EVENT = "response.elicitation_request"

# Every elicitation resolves to one of three MCP-shaped verdicts
# (omnigent.server.schemas.ElicitationResult.action: accept/decline/cancel).
# Offering exactly "accept" / "decline" as the Ask's options keeps the
# person's answer usable verbatim as that verdict, with no separate
# translation table to keep in sync.
_ELICITATION_ACTIONS = (
    AskAction(id="accept", label="Approve"),
    AskAction(id="decline", label="Decline"),
)


def on_session_event(conversation_id: str, event: dict[str, Any]) -> None:
    """Mirror an outstanding elicitation into a durable Ask.

    Called from the same chokepoint as
    :func:`omnigent.runtime.pending_elicitations.record_publish`, so it must
    stay cheap for the overwhelming majority of events that are not
    elicitations, and must never raise into the publish path — every
    failure is caught and logged here, not propagated.

    Only a ``response.elicitation_request`` on a Nova private session
    (``nova.scope == "private"``) becomes an Ask; a project-scoped session's
    elicitations stay exactly as they are today (the web ApprovalCard),
    since a project session's collaborators — not just its owner — may need
    to answer them, and "Waiting on you" is the owner's private surface.

    :param conversation_id: The session the event was published on.
    :param event: The event payload, as passed to
        :func:`~omnigent.runtime.session_stream.publish`.
    """
    if event.get("type") != _ELICITATION_REQUEST_EVENT:
        return
    elicitation_id = event.get("elicitation_id")
    if not isinstance(elicitation_id, str) or not elicitation_id:
        return
    try:
        _mirror_elicitation(conversation_id, elicitation_id, event)
    except Exception:  # noqa: BLE001 — the SSE publish path must never raise
        _logger.warning(
            "Failed to mirror elicitation %s as a Nova Ask", elicitation_id, exc_info=True
        )


def _mirror_elicitation(conversation_id: str, elicitation_id: str, event: dict[str, Any]) -> None:
    """The dependency-touching body of :func:`on_session_event`.

    Isolated from it so the try/except in the caller can wrap this whole body.
    """
    actor, _refusal = private_actor(conversation_id)
    if actor is None:
        # Silent, not a model-facing refusal: this runs on the SSE publish
        # path, not in response to a tool call, so there is no one to hand
        # an error message to.
        return
    ask_store = _asks._runtime_store()
    if ask_store.get_by_elicitation(elicitation_id) is not None:
        # Already mirrored — a harness reconnect can republish the identical
        # request; record_publish's own dict-assignment idempotency means we
        # may see it again with nothing new to record.
        return
    params = event.get("params")
    params = params if isinstance(params, dict) else {}
    text = str(params.get("message") or "Nova needs your input")
    try:
        AskService(ask_store).open_ask(
            actor=actor,
            kind=AskKind.APPROVAL,
            text=text,
            actions=_ELICITATION_ACTIONS,
            session_id=conversation_id,
            elicitation_id=elicitation_id,
        )
    except OmnigentError:
        # ALREADY_EXISTS from a race against the pre-check above (or any
        # other validation surprise from an unusually-shaped event) — the
        # elicitation itself is unaffected either way.
        _logger.debug("Could not open an Ask for elicitation %s", elicitation_id, exc_info=True)


async def on_answered(ask: Ask, answer_text: str) -> None:
    """Deliver an answered Ask's verdict back to Omnigent, if it came from one.

    Called by ``routes.py`` right after :func:`omnigent.nova.asks.service.answer`
    persists the answer. Two paths, matching the module docstring:

    * **The elicitation is still live** (same server process, not yet
      resolved another way): resolve it exactly as the web ApprovalCard
      would, via the same shared resolver every other resolution path uses
      (:func:`_resolve_live`).
    * **It is gone** (server restarted, or resolved elsewhere while this Ask
      sat unanswered): the answer becomes a normal user message in the
      session instead, so the person's reply isn't silently lost
      (:func:`_post_as_message`).

    Which path runs is decided by
    :func:`omnigent.runtime.pending_elicitations.lookup` — the same
    in-process index the sidebar badge and the ApprovalCard read, and one
    that cannot outlive the process (see that module's docstring), which is
    exactly the "still live vs. after restart" distinction this needs.

    :param ask: The just-answered Ask (already ``ANSWERED`` in the store).
    :param answer_text: The person's answer, as recorded on the Ask.
    """
    if ask.elicitation_id is None or ask.session_id is None:
        return  # A Nova-originated Ask (a tool, Goals, Feed) has nothing to resolve.
    from omnigent.runtime import pending_elicitations

    pending = pending_elicitations.lookup(ask.elicitation_id)
    if pending is not None and pending[0] == ask.session_id:
        await _resolve_live(ask, answer_text)
    else:
        await _post_as_message(ask, answer_text)


async def _resolve_live(ask: Ask, answer_text: str) -> None:
    """Resolve a still-outstanding elicitation, same path as the web ApprovalCard."""
    assert ask.session_id is not None  # checked by on_answered before dispatching here
    from omnigent.runtime import get_conversation_store
    from omnigent.server.routes._sessions.common import get_server_runner_router
    from omnigent.server.routes._sessions.orchestration import _resolve_elicitation

    data = {"elicitation_id": ask.elicitation_id, "action": answer_text}
    await _resolve_elicitation(
        ask.session_id, data, get_server_runner_router(), get_conversation_store()
    )


async def _post_as_message(ask: Ask, answer_text: str) -> None:
    """Deliver a stale-elicitation's answer as an ordinary user message.

    Dispatched immediately when the session's runner is currently connected
    (the same forward every other typed message gets); otherwise simply
    persisted as history — Asks does not relaunch a cold session, the same
    as an ordinary chat message sent to an offline host today.
    """
    from omnigent.entities import MessageData, NewConversationItem
    from omnigent.runtime import get_conversation_store
    from omnigent.server.routes._sessions.common import get_server_runner_router
    from omnigent.server.routes._sessions.helpers import _get_runner_client
    from omnigent.server.schemas import SessionEventInput

    assert ask.session_id is not None
    conversation_store = get_conversation_store()
    conversation = await asyncio.to_thread(conversation_store.get_conversation, ask.session_id)
    if conversation is None:
        return
    content = [{"type": "input_text", "text": answer_text}]
    runner_router = get_server_runner_router()
    runner_client = await _get_runner_client(
        ask.session_id, runner_router, conversation=conversation
    )
    if runner_client is not None:
        from omnigent.server.routes._sessions.orchestration import (
            _dispatch_session_event_to_runner,
        )

        await _dispatch_session_event_to_runner(
            ask.session_id,
            conversation,
            SessionEventInput(type="message", data={"role": "user", "content": content}),
            conversation_store,
            runner_client,
            agent_name=None,
            file_store=None,
            artifact_store=None,
            created_by=ask.user_id,
            runner_router=runner_router,
        )
        return
    # No live runner — the common case right after a restart. Persist the
    # answer as plain history; the existing launch-on-next-message path
    # (owned by the session routes, not Asks) picks it up the next time the
    # person opens this session or sends anything else.
    await asyncio.to_thread(
        conversation_store.append,
        ask.session_id,
        [
            NewConversationItem(
                type="message",
                response_id=f"resp_{uuid.uuid4().hex[:24]}",
                data=MessageData(role="user", content=content),
                created_by=ask.user_id,
            )
        ],
    )
