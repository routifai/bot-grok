"""The family event stream (omnigent.superchat.family): which events reach the root's stream."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.family.signals import notify_chats_changed, notify_message_done
from omnigent.superchat.family.stream import watch_family

_MODE = {"omnigent.context.mode": "superside-chat"}


class _Bus:
    """An in-memory stand-in for ``session_stream``: one queue per conversation."""

    def __init__(self) -> None:
        self.queues: dict[str, asyncio.Queue[dict]] = {}

    def subscribe(self, conversation_id: str) -> AsyncIterator[dict]:
        queue = self.queues.setdefault(conversation_id, asyncio.Queue())

        async def events() -> AsyncIterator[dict]:
            while True:
                yield await queue.get()

        return events()

    def publish(self, conversation_id: str, event: dict) -> None:
        self.queues.setdefault(conversation_id, asyncio.Queue()).put_nowait(event)


def _assistant_done(item_id: str) -> dict:
    return {
        "type": "response.output_item.done",
        "item": {"id": item_id, "type": "message", "role": "assistant"},
    }


def _family(store: SqlAlchemyConversationStore) -> tuple[str, str]:
    root = store.create_conversation(kind="default", title="Super", labels=_MODE)
    side = store.create_conversation(
        kind="default",
        title="Side",
        labels={**_MODE, SIDE_CHAT_LABEL_KEY: "true", "omnigent.side_chat.parent_id": root.id},
    )
    return root.id, side.id


async def _next(stream: AsyncIterator[dict]) -> dict:
    return await asyncio.wait_for(anext(stream), timeout=2)


async def _open(store: SqlAlchemyConversationStore, root_id: str, bus: _Bus):
    stream = watch_family(
        store, root_id, debounce_s=0.01, heartbeat_s=0.3, subscribe=bus.subscribe
    )
    seen = [await _next(stream), await _next(stream)]  # chats + activities on connect
    assert {e["type"] for e in seen} == {"chats.changed", "activities.changed"}
    await asyncio.sleep(0.05)  # the per-session pumps are subscribed
    return stream


async def test_a_side_chats_message_reaches_the_roots_stream_with_ids_only(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    root_id, side_id = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    notify_message_done(side_id, "item_1")
    assert await _next(stream) == {"type": "message.done", "chat_id": side_id, "item_id": "item_1"}
    notify_message_done(root_id, "item_2")
    event = await _next(stream)
    while event["type"] == "activities.changed":  # the feed signal rides along
        event = await _next(stream)
    assert event == {"type": "message.done", "chat_id": root_id, "item_id": "item_2"}
    await stream.aclose()


async def test_an_unrelated_sessions_message_does_not_reach_the_stream(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    root_id, _ = _family(conversation_store)
    other_id, _ = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    notify_message_done(other_id, "item_x")
    # An unwatched session has no subscriber; the next frame is the quiet-time heartbeat.
    assert (await _next(stream))["type"] == "session.heartbeat"
    await stream.aclose()


async def test_message_done_comes_only_from_the_persist_seam(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A live output_item.done carries a runner id, so it is not a message.done."""
    root_id, _ = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    bus.publish(root_id, _assistant_done("runner_id"))
    kinds = []
    while not kinds or kinds[-1] != "session.heartbeat":
        kinds.append((await _next(stream))["type"])
    assert "message.done" not in kinds
    await stream.aclose()


async def test_a_turn_ending_in_any_family_chat_is_a_turn_done(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """A failed turn stores an error item, not a message: turn.done still tells clients."""
    root_id, side_id = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    bus.publish(side_id, {"type": "response.failed", "response": {}})
    bus.publish(root_id, {"type": "response.completed", "response": {}})
    seen = []
    while len(seen) < 2:
        event = await _next(stream)
        if event["type"] == "turn.done":
            seen.append(event)
    assert seen == [
        {"type": "turn.done", "chat_id": side_id, "status": "failed"},
        {"type": "turn.done", "chat_id": root_id, "status": "completed"},
    ]
    await stream.aclose()


async def test_relay_persist_and_external_publish_signal_the_stored_id(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    from omnigent.entities import MessageData, NewConversationItem
    from omnigent.server.routes._sessions.helpers import (
        _publish_external_conversation_item,
        _relay_persist,
    )

    root_id, side_id = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)

    def reply(text: str, **extra: object) -> NewConversationItem:
        data = MessageData(
            role="assistant",
            agent="brain",
            content=[{"type": "output_text", "text": text}],
            **extra,
        )
        return NewConversationItem(type="message", response_id="r1", data=data)

    await _relay_persist(conversation_store, side_id, reply("via relay"))
    stored = conversation_store.list_items(side_id, order="desc", limit=1).data[0]
    assert await _next(stream) == {
        "type": "message.done",
        "chat_id": side_id,
        "item_id": stored.id,
    }
    # Hidden context is never a message.
    await _relay_persist(conversation_store, side_id, reply("hidden", is_meta=True))
    native = conversation_store.append(root_id, [reply("native")])[0]
    _publish_external_conversation_item(root_id, native)
    event = await _next(stream)
    while event["type"] == "activities.changed":
        event = await _next(stream)
    assert event == {"type": "message.done", "chat_id": root_id, "item_id": native.id}
    await stream.aclose()


async def test_rename_and_opened_side_chat_signal_chats_changed(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    root_id, side_id = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    bus.publish(side_id, {"type": "session.title", "conversation_id": side_id, "title": "New"})
    assert await _next(stream) == {"type": "chats.changed", "root_id": root_id}
    notify_chats_changed(root_id)
    event = await _next(stream)
    while event["type"] == "activities.changed":
        event = await _next(stream)
    assert event == {"type": "chats.changed", "root_id": root_id}
    await stream.aclose()


async def test_an_archived_side_chat_is_noticed_on_the_heartbeat(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    root_id, side_id = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    conversation_store.update_conversation(side_id, archived=True)
    types = [(await _next(stream))["type"] for _ in range(2)]
    assert types == ["chats.changed", "session.heartbeat"]
    await stream.aclose()


async def test_not_a_super_chat_ends_after_the_opening_event(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    plain = conversation_store.create_conversation(kind="default", title="Plain", labels={})
    stream = watch_family(conversation_store, plain.id, subscribe=_Bus().subscribe)
    assert [e["type"] async for e in stream] == ["chats.changed"]


async def test_a_message_sent_mid_turn_is_announced_with_how_it_was_taken(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    root_id, _ = _family(conversation_store)
    bus = _Bus()
    stream = await _open(conversation_store, root_id, bus)
    bus.publish(
        root_id,
        {"type": "session.input.delivery", "data": {"item_id": "msg_9"}},
    )
    event = await _next(stream)
    while event["type"] == "activities.changed":
        event = await _next(stream)
    assert event == {
        "type": "message.delivery",
        "chat_id": root_id,
        "item_id": "msg_9",
    }
    await stream.aclose()
