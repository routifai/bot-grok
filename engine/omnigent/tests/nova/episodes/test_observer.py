"""Tests for ``omnigent.nova.episodes.observer.on_turn_completed``.

A fake conversation store stands in for the server's real one, since this
primitive only ever reads it through the small surface ``observer.py`` uses:
``get_conversation``, ``get_session_owner`` and ``list_items``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from omnigent.entities.conversation import (
    Conversation,
    ConversationItem,
    FunctionCallData,
    MessageData,
)
from omnigent.entities.pagination import PagedList
from omnigent.nova import episodes as _episodes
from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.observer import on_turn_completed
from omnigent.nova.episodes.store import EpisodeStore

SESSION_ID = "conv_abc"
TURN_ID = "resp_1"


def _conversation(labels: dict[str, str] | None = None) -> Conversation:
    return Conversation(
        id=SESSION_ID,
        created_at=1_700_000_000,
        updated_at=1_700_000_000,
        root_conversation_id=SESSION_ID,
        labels={"nova.scope": "private"} if labels is None else labels,
    )


def _user_message(text: str, *, item_id: str = "msg_user") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="message",
        status="completed",
        response_id="resp_0",
        created_at=1_700_000_000,
        data=MessageData(role="user", content=[{"type": "input_text", "text": text}]),
    )


def _assistant_message(text: str, *, item_id: str = "msg_assistant") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="message",
        status="completed",
        response_id=TURN_ID,
        created_at=1_700_000_050,
        data=MessageData(
            role="assistant",
            content=[{"type": "output_text", "text": text}],
            agent="nova",
        ),
    )


def _function_call(name: str, *, item_id: str = "call_1") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="function_call",
        status="completed",
        response_id=TURN_ID,
        created_at=1_700_000_025,
        data=FunctionCallData(agent="nova", name=name, arguments="{}", call_id=item_id),
    )


@dataclass
class _FakeConversationStore:
    """The narrow slice of ``ConversationStore`` ``observer.py`` reads."""

    conversation: Conversation | None
    owner_user_id: str | None
    items_newest_first: list[ConversationItem] = field(default_factory=list)
    raise_on_get_conversation: bool = False

    def get_conversation(self, conversation_id: str) -> Conversation | None:
        del conversation_id
        if self.raise_on_get_conversation:
            raise RuntimeError("boom")
        return self.conversation

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del conversation_id, owner_only
        return self.owner_user_id

    def list_items(
        self,
        conversation_id: str,
        limit: int = 100,
        after: str | None = None,
        before: str | None = None,
        order: str = "asc",
        type: str | None = None,
    ) -> PagedList[ConversationItem]:
        del conversation_id, after, before, order, type
        return PagedList(data=self.items_newest_first[:limit])


class _FakeEpisodeStore(EpisodeStore):
    """In-memory store recording every ``upsert`` call it receives."""

    def __init__(self) -> None:
        super().__init__("memory://")
        self.upserts: list[dict[str, object]] = []

    def upsert(
        self,
        *,
        actor: NovaActor,
        session_id: str,
        turn_id: str,
        title: str,
        summary: str,
        tools: tuple[str, ...],
        links: tuple[str, ...],
        created_at: int,
    ) -> Episode:
        self.upserts.append(
            {
                "actor": actor,
                "session_id": session_id,
                "turn_id": turn_id,
                "title": title,
                "summary": summary,
                "tools": tools,
                "created_at": created_at,
            }
        )
        return Episode(
            id="e" * 32,
            workspace_id=actor.workspace_id,
            user_id=actor.user_id,
            session_id=session_id,
            turn_id=turn_id,
            title=title,
            summary=summary,
            tools=tools,
            links=links,
            created_at=created_at,
        )

    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        raise NotImplementedError

    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:
        raise NotImplementedError


@pytest.mark.asyncio
async def test_records_an_eligible_turn() -> None:
    conversation_store = _FakeConversationStore(
        conversation=_conversation(),
        owner_user_id="alice@example.com",
        items_newest_first=[
            _assistant_message("I found the best mortgage rate."),
            _function_call("web_search"),
            _user_message("find the best mortgage rate"),
        ],
    )
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert len(store.upserts) == 1
    recorded = store.upserts[0]
    assert recorded["actor"] == NovaActor(user_id="alice@example.com", workspace_id=0)
    assert recorded["session_id"] == SESSION_ID
    assert recorded["turn_id"] == TURN_ID
    assert recorded["tools"] == ("web_search",)
    assert "mortgage" in str(recorded["title"]).lower()


@pytest.mark.asyncio
async def test_skips_non_private_session() -> None:
    conversation_store = _FakeConversationStore(
        conversation=_conversation(labels={"nova.scope": "project"}),
        owner_user_id="alice@example.com",
        items_newest_first=[
            _assistant_message("Done."),
            _function_call("web_search"),
            _user_message("do something"),
        ],
    )
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []


@pytest.mark.asyncio
async def test_skips_when_conversation_not_found() -> None:
    conversation_store = _FakeConversationStore(
        conversation=None, owner_user_id="alice@example.com"
    )
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []


@pytest.mark.asyncio
async def test_skips_when_owner_unresolved() -> None:
    conversation_store = _FakeConversationStore(conversation=_conversation(), owner_user_id=None)
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []


@pytest.mark.asyncio
async def test_skips_when_no_prior_user_message_in_lookback() -> None:
    conversation_store = _FakeConversationStore(
        conversation=_conversation(),
        owner_user_id="alice@example.com",
        items_newest_first=[_assistant_message("Done."), _function_call("web_search")],
    )
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []


@pytest.mark.asyncio
async def test_skips_turn_with_no_work_tool() -> None:
    conversation_store = _FakeConversationStore(
        conversation=_conversation(),
        owner_user_id="alice@example.com",
        items_newest_first=[
            _assistant_message("Here is what I recalled."),
            _function_call("search_conversations"),
            _user_message("what did we discuss last time"),
        ],
    )
    store = _FakeEpisodeStore()

    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []


@pytest.mark.asyncio
async def test_a_broken_runtime_store_is_a_quiet_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    # No `store=` argument: falls back to `_episodes._runtime_store()`, which
    # here raises (e.g. the runtime was never initialized) — must still not
    # break the caller's relay loop.
    def _boom() -> EpisodeStore:
        raise RuntimeError("runtime not initialized")

    monkeypatch.setattr(_episodes, "_runtime_store", _boom)
    conversation_store = _FakeConversationStore(
        conversation=_conversation(),
        owner_user_id="alice@example.com",
        items_newest_first=[
            _assistant_message("Done."),
            _function_call("web_search"),
            _user_message("do something"),
        ],
    )
    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=None)


@pytest.mark.asyncio
async def test_never_raises_when_the_conversation_store_fails() -> None:
    conversation_store = _FakeConversationStore(
        conversation=_conversation(),
        owner_user_id="alice@example.com",
        raise_on_get_conversation=True,
    )
    store = _FakeEpisodeStore()

    # Must not raise: a failure here can never affect the caller's relay.
    await on_turn_completed(conversation_store, SESSION_ID, TURN_ID, store=store)

    assert store.upserts == []
