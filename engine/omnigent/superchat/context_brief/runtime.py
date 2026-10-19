"""Runner side of the context brief: started when the message is accepted, read by the tool.

The runner accepting a Conversation message (``Feature.on_accept``) starts the build in the
background, before the turn's setup and prefix, which never wait on it (ADR 0026); the
``context_brief`` call then returns the brief for that message, at once once it is built (at
most :data:`~.brief.BUDGET_SECONDS` after the message, and never more than
:data:`BRIEF_WAIT_SECONDS` of the call's own time). One brief per session: kept for
:data:`BRIEF_TTL_SECONDS` or until the turn ends, so a second call in the turn gets the same text.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass

import httpx

from omnigent.entities.conversation import is_system_notice_text
from omnigent.superchat._handler_http import error
from omnigent.superchat.context_brief.brief import BUDGET_SECONDS, Brief
from omnigent.superchat.context_brief.sources import RunnerSources
from omnigent.superchat.feature import HandlerCtx, is_helper

_logger = logging.getLogger(__name__)

#: How long a session's brief answers the tool after its message arrived.
BRIEF_TTL_SECONDS = 120.0
#: Longest the tool call waits for the brief: its build's own budget plus room to render.
BRIEF_WAIT_SECONDS = BUDGET_SECONDS + 0.5
_RECENT_ITEMS = 10


@dataclass(frozen=True)
class _Entry:
    message: str
    started: float
    task: asyncio.Task[str]


#: Per session: the brief of the turn in flight.
_briefs: dict[str, _Entry] = {}


async def _render(client: httpx.AsyncClient, conversation_id: str, message: str) -> str:
    try:
        brief = await Brief.build(conversation_id, message, RunnerSources(client))
    except Exception:  # the brief is never a reason to fail a call
        _logger.warning("context brief failed; an empty one is returned", exc_info=True)
        brief = Brief()
    return brief.render()


def start_brief(
    client: httpx.AsyncClient, conversation_id: str, message: str
) -> asyncio.Task[str]:
    """The session's brief for *message*: the one already building, or a new build."""
    entry = _briefs.get(conversation_id)
    now = time.monotonic()
    if entry is None or entry.message != message or now - entry.started > BRIEF_TTL_SECONDS:
        task = asyncio.get_running_loop().create_task(_render(client, conversation_id, message))
        entry = _Entry(message, now, task)
        _briefs[conversation_id] = entry
    return entry.task


def forget_brief(conversation_id: str) -> None:
    """Drop the session's brief (its turn ended)."""
    _briefs.pop(conversation_id, None)


def _message(texts: Sequence[str]) -> str:
    return "\n".join(t for t in texts if t).strip()


def begin_brief(
    client: httpx.AsyncClient | None, conversation_id: str, texts: Sequence[str]
) -> None:
    """Start this message's brief as the runner accepts it; the brief is a tool result, never a
    block. A runtime notice (a Helper finished, a timer fired) starts none.

    Keyed by the message's text: the hook sees the message's texts, not its item id.
    """
    message = _message(texts)
    if client is not None and message and not any(is_system_notice_text(t) for t in texts):
        start_brief(client, conversation_id, message)


async def _latest_message(client: httpx.AsyncClient, conversation_id: str) -> str:
    """The person's latest message, for a call with no brief started (e.g. a runner restart)."""
    from omnigent.superchat.recall_hint.hint import item_text

    resp = await client.get(
        f"/v1/sessions/{conversation_id}/items",
        params={"limit": str(_RECENT_ITEMS), "order": "desc"},
        timeout=5.0,
    )
    items = resp.json().get("data", []) if resp.status_code == 200 else []
    for item in items:
        if isinstance(item, dict) and item.get("type") == "message" and item.get("role") == "user":
            return item_text(item).strip()
    return ""


async def handle_context_brief(ctx: HandlerCtx, _args: dict[str, object]) -> str:
    """The brief for the current turn: the cached one, or one built now when none is."""
    if ctx.server_client is None or not ctx.conversation_id or is_helper(ctx.labels):
        return error("context_brief is for the conversation only")
    entry = _briefs.get(ctx.conversation_id)
    if entry is not None and time.monotonic() - entry.started <= BRIEF_TTL_SECONDS:
        task = entry.task
    else:
        try:
            message = await _latest_message(ctx.server_client, ctx.conversation_id)
        except (httpx.HTTPError, ValueError, AttributeError):
            message = ""
        task = start_brief(ctx.server_client, ctx.conversation_id, message)
    # A call cancelled mid-wait, or out of time, leaves the brief building for the next one.
    try:
        return await asyncio.wait_for(asyncio.shield(task), BRIEF_WAIT_SECONDS)
    except TimeoutError:
        _logger.info(
            "context brief not ready within %.1fs; an empty one is returned", BRIEF_WAIT_SECONDS
        )
        return Brief().render()
