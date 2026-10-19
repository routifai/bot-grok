"""In-process signals for family changes that no session stream carries.

Producers (a store-persisted assistant message, a rename or archive) call
``notify_*``; each family stream listening for that chat or root gets the event. Thread-safe:
producers may run on worker threads.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable
from typing import Any

from omnigent.stores.conversation_store import ConversationStore
from omnigent.superchat.family.tree import resolve_super_chat_id

_lock = threading.Lock()
_listeners: dict[str, set[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict]]]] = {}


def _listen(key: str, queue: asyncio.Queue[dict]) -> Callable[[], None]:
    entry = (asyncio.get_running_loop(), queue)
    with _lock:
        _listeners.setdefault(key, set()).add(entry)

    def stop() -> None:
        with _lock:
            _listeners.get(key, set()).discard(entry)

    return stop


def _notify(key: str, event: dict[str, Any]) -> None:
    with _lock:
        targets = list(_listeners.get(key, ()))
    for loop, queue in targets:
        loop.call_soon_threadsafe(queue.put_nowait, event)


def listen_chats_changed(root_id: str, queue: asyncio.Queue[dict]) -> Callable[[], None]:
    """Deliver ``chats.changed`` for *root_id* into *queue* (call from the queue's loop).

    :returns: A function that stops the delivery.
    """
    return _listen(f"chats:{root_id}", queue)


def notify_chats_changed(root_id: str) -> None:
    """Tell every family stream of *root_id* that its chats changed."""
    _notify(f"chats:{root_id}", {"type": "chats.changed", "root_id": root_id})


async def notify_session_changed(conv_store: ConversationStore, session_id: str) -> None:
    """A session was renamed or (un)archived: tell its family's streams, if it has one."""
    root_id = await asyncio.to_thread(resolve_super_chat_id, conv_store, session_id)
    if root_id is not None:
        notify_chats_changed(root_id)


def listen_message_done(chat_id: str, queue: asyncio.Queue[dict]) -> Callable[[], None]:
    """Deliver ``message.done`` for assistant messages stored in *chat_id* into *queue*."""
    return _listen(f"msg:{chat_id}", queue)


def notify_message_done(chat_id: str, item_id: str) -> None:
    """An assistant message was stored in *chat_id* under the store-assigned *item_id*."""
    _notify(f"msg:{chat_id}", {"type": "message.done", "chat_id": chat_id, "item_id": item_id})


def notify_chat_reset(chat_id: str, item_id: str) -> None:
    """*chat_id* was cleared (``POST .../reset``); *item_id* is its reset checkpoint."""
    _notify(f"msg:{chat_id}", {"type": "chat.reset", "chat_id": chat_id, "item_id": item_id})


def notify_item_updated(chat_id: str, item_id: str) -> None:
    """A stored item of *chat_id* changed (a person's message gained or changed its artifact link).

    Sent as ``message.delivery``: the frame the web already refetches the chat's transcript on.
    """
    _notify(f"msg:{chat_id}", {"type": "message.delivery", "chat_id": chat_id, "item_id": item_id})


def notify_artifacts_changed(root_id: str, group_id: str) -> None:
    """A version of the file *group_id* was saved in the Conversation *root_id*.

    Sent as ``artifacts.changed`` on the family stream (through the stream's chats listener), so
    an open view of the file (its studio) refreshes at once instead of at its next poll.
    """
    _notify(
        f"chats:{root_id}",
        {"type": "artifacts.changed", "root_id": root_id, "group_id": group_id},
    )


def listening(root_id: str) -> bool:
    """Whether a family stream of the Conversation *root_id* is open."""
    with _lock:
        return bool(_listeners.get(f"chats:{root_id}"))


def notify_round_updated(root_id: str, round_id: str, summary: dict[str, Any]) -> None:
    """The Round *round_id* of the Conversation *root_id* changed.

    Sent as ``round.updated`` on the family stream with the Round's summary
    (:func:`omnigent.superchat.rounds.fold.summary`); the client reads the full view from
    ``GET /v1/sessions/{root_id}/rounds/{round_id}``.
    """
    _notify(
        f"chats:{root_id}",
        {"type": "round.updated", "root_id": root_id, "round_id": round_id, **summary},
    )
