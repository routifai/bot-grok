"""Per-viewer unread state of a family's chats, from the server's read-state.

A chat is unread for a viewer when they flagged it unread, or when its newest assistant reply
is newer than the last time they read it (never read: newer than the chat itself). So a new
reply makes the chat unread with no write on the reply path, and ``POST .../read`` clears it.
Read-state is the per-user store ``PUT .../read-state`` and the session list already use
(in memory, per workspace; it resets with the server).
"""

from __future__ import annotations

import time
from typing import Any

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.entities import ConversationItem, MessageData
from omnigent.stores import ConversationStore

#: Newest message items read per chat to find its latest reply.
_MESSAGES_SCANNED = 10


def _last_reply_at(items: list[ConversationItem]) -> int | None:
    """``created_at`` of the newest assistant message in newest-first *items*."""
    for item in items:
        data = item.data
        if isinstance(data, MessageData) and data.role == "assistant" and not data.is_meta:
            return item.created_at
    return None


def unread_by_chat(
    conv_store: ConversationStore, user_id: str | None, chats: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """``{chat_id: {"unread", "last_read_at"}}`` for *chats* (``list_related_chats`` rows).

    One batched read of the chats' newest messages.
    """
    from omnigent.server.routes._sessions.helpers import _read_state_entry

    ids = [chat["id"] for chat in chats]
    latest = conv_store.list_latest_message_items_for_conversations(ids, _MESSAGES_SCANNED)
    out: dict[str, dict[str, Any]] = {}
    for chat in chats:
        last_seen, flagged = _read_state_entry(user_id, chat["id"])
        reply_at = _last_reply_at(latest.get(chat["id"], []))
        if reply_at is None:
            newer = False
        elif last_seen is None:  # never read: any reply since the chat opened (not a copy)
            newer = reply_at >= (chat.get("created_at") or 0)
        else:
            newer = reply_at > last_seen
        out[chat["id"]] = {
            "unread": flagged or newer,
            "last_read_at": last_seen,
        }
    return out


def mark_read(
    conv_store: ConversationStore,
    user_id: str | None,
    session_id: str,
    item_id: str | None,
) -> int | None:
    """Mark *session_id* read for *user_id*, up to *item_id* (default: now).

    The baseline only moves forward; the explicit unread flag is cleared.

    :returns: The new ``last_read_at``, or ``None`` when *item_id* is not in the session.
    """
    from omnigent.server.routes._sessions.helpers import _read_state_entry, _set_read_state

    if item_id is not None:
        try:
            uuid_to_bytes(item_id)
        except InvalidUuidError:
            return None
        item = conv_store.get_item(session_id, item_id)
        if item is None:
            return None
        at = item.created_at
    else:
        at = int(time.time())
    last_seen, _ = _read_state_entry(user_id, session_id)
    read_at = max(at, last_seen or 0)
    _set_read_state(user_id, session_id, read_at, False)
    return read_at
