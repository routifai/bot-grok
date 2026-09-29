"""Records an episode when a Nova private session's turn finishes.

Called from the server's relay loop (see ``orchestration.py``'s
``response.completed`` handling) as a fire-and-forget task. Never raises: a
failure here must never affect the turn it is recording.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from omnigent.nova._shared import NovaActor, Scope, scope_from_labels
from omnigent.nova.episodes import _runtime
from omnigent.nova.episodes.service import record_turn
from omnigent.nova.episodes.store import EpisodeStore

if TYPE_CHECKING:
    from omnigent.entities.conversation import ConversationItem
    from omnigent.stores import ConversationStore

_logger = logging.getLogger(__name__)

# Generous bound on how far back to scan for this turn's items: enough for a
# long multi-step tool loop, small enough to never be an unbounded read.
_LOOKBACK_ITEMS = 200


async def on_turn_completed(
    conversation_store: ConversationStore,
    session_id: str,
    turn_id: str,
    *,
    store: EpisodeStore | None = None,
) -> None:
    """Best-effort: record the turn that just completed as an episode.

    No-ops (quietly) when: no store is configured, the session is not a
    private Nova session, its owner cannot be resolved, no prior user message
    is found within the lookback window, or the turn is not eligible per
    :func:`omnigent.nova.episodes.service.record_turn` (no work tool used, or
    an empty/``NO_RESPONSE`` reply).

    :param conversation_store: The server's :class:`ConversationStore`.
    :param session_id: The session the turn ran in.
    :param turn_id: The turn's response id, for idempotent recording.
    :param store: The episode store to write to; defaults to the store
        ``routes.create_router`` configured at startup. Tests pass one
        explicitly instead of relying on that global.
    """
    try:
        await _on_turn_completed(conversation_store, session_id, turn_id, store=store)
    except Exception:  # noqa: BLE001 — must never break the caller's relay loop
        _logger.warning("Nova: episode recording failed for session=%s", session_id, exc_info=True)


async def _on_turn_completed(
    conversation_store: ConversationStore,
    session_id: str,
    turn_id: str,
    *,
    store: EpisodeStore | None,
) -> None:
    episode_store = store or _runtime.store()
    if episode_store is None:
        return

    conversation = await asyncio.to_thread(conversation_store.get_conversation, session_id)
    if conversation is None or scope_from_labels(conversation.labels) is not Scope.PRIVATE:
        return

    owner_user_id = await asyncio.to_thread(
        conversation_store.get_session_owner, session_id, owner_only=True
    )
    if owner_user_id is None:
        return

    page = await asyncio.to_thread(
        conversation_store.list_items, session_id, limit=_LOOKBACK_ITEMS, order="desc"
    )
    request, reply, tools = _turn_fields(page.data)
    if request is None or reply is None:
        return

    # Ambient per-request workspace, exactly as omnigent.nova._shared.identity
    # builds a NovaActor from a request; there is no request here.
    from omnigent.db.db_models import current_workspace_id

    actor = NovaActor(user_id=owner_user_id, workspace_id=current_workspace_id())
    record_turn(
        episode_store,
        actor=actor,
        session_id=session_id,
        turn_id=turn_id,
        request=request,
        reply=reply,
        tools=tools,
    )


def _turn_fields(
    items_newest_first: list[ConversationItem],
) -> tuple[str | None, str | None, list[str]]:
    """Walk newest-first conversation items back to the triggering user message.

    The most recent assistant message is the reply; every ``function_call``
    seen before the boundary user message names a tool that was used.

    :param items_newest_first: One page of :class:`ConversationItem`,
        ``order="desc"``.
    :returns: ``(request, reply, tool_names)``. ``request``/``reply`` are
        ``None`` when no prior user message (respectively no assistant reply)
        was found within the page.
    """
    from omnigent.entities import FunctionCallData, MessageData

    reply: str | None = None
    tools: list[str] = []
    for item in items_newest_first:
        if item.type == "message" and isinstance(item.data, MessageData):
            if item.data.role == "assistant":
                if reply is None:
                    reply = _message_text(item.data.content)
            elif item.data.role == "user":
                return _message_text(item.data.content), reply, list(reversed(tools))
        elif item.type == "function_call" and isinstance(item.data, FunctionCallData):
            tools.append(item.data.name)
    return None, reply, list(reversed(tools))


def _message_text(content: list[dict[str, Any]]) -> str:
    """Join a message's text content blocks, as ``search_conversations`` does."""
    parts = [str(text) for block in content if (text := block.get("text"))]
    return "\n".join(parts)
