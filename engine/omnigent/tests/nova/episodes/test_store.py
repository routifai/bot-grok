"""Tests for :class:`SqlAlchemyEpisodeStore` against a real SQLite database.

Exercises ``upsert`` (insert, idempotent update, id stability), ``list_recent``
(order, limit, owner scoping) and ``delete`` (idempotent, owner scoping).
"""

from __future__ import annotations

import pytest

from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore

ALICE = NovaActor(user_id="alice@example.com", workspace_id=0)
BOB = NovaActor(user_id="bob@example.com", workspace_id=0)


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyEpisodeStore:
    """A fresh :class:`SqlAlchemyEpisodeStore` backed by the test SQLite DB."""
    return SqlAlchemyEpisodeStore(db_uri)


def _upsert(
    store: SqlAlchemyEpisodeStore,
    *,
    actor: NovaActor = ALICE,
    session_id: str = "conv_1",
    turn_id: str = "resp_1",
    title: str = "Title",
    summary: str = "Summary",
    tools: tuple[str, ...] = ("web_search",),
    links: tuple[str, ...] = (),
    created_at: int = 1_700_000_000,
):
    return store.upsert(
        actor=actor,
        session_id=session_id,
        turn_id=turn_id,
        title=title,
        summary=summary,
        tools=tools,
        links=links,
        created_at=created_at,
    )


# ── upsert ───────────────────────────────────────────────────────────────────


def test_upsert_inserts_a_new_episode(store: SqlAlchemyEpisodeStore) -> None:
    episode = _upsert(store)
    assert episode.session_id == "conv_1"
    assert episode.turn_id == "resp_1"
    assert episode.title == "Title"
    assert episode.tools == ("web_search",)
    assert episode.created_at == 1_700_000_000
    assert episode.updated_at is None


def test_upsert_is_idempotent_per_turn(store: SqlAlchemyEpisodeStore) -> None:
    first = _upsert(store, title="First title", created_at=1_700_000_000)
    second = _upsert(store, title="Second title", created_at=1_700_000_100)
    # Same (session_id, turn_id): one row, updated in place, same id.
    assert second.id == first.id
    assert second.title == "Second title"
    assert second.updated_at == 1_700_000_100

    recent = store.list_recent(actor=ALICE, limit=10)
    assert len(recent) == 1
    assert recent[0].title == "Second title"


def test_upsert_distinguishes_turns_in_the_same_session(store: SqlAlchemyEpisodeStore) -> None:
    _upsert(store, turn_id="resp_1")
    _upsert(store, turn_id="resp_2")
    assert len(store.list_recent(actor=ALICE, limit=10)) == 2


def test_upsert_round_trips_tools_and_links(store: SqlAlchemyEpisodeStore) -> None:
    episode = _upsert(
        store,
        tools=("browser_navigate", "web_search"),
        links=("https://example.com/a", "https://example.com/b"),
    )
    assert episode.tools == ("browser_navigate", "web_search")
    assert episode.links == ("https://example.com/a", "https://example.com/b")


# ── list_recent ──────────────────────────────────────────────────────────────


def test_list_recent_orders_newest_first(store: SqlAlchemyEpisodeStore) -> None:
    _upsert(store, turn_id="resp_1", title="Old", created_at=1_700_000_000)
    _upsert(store, turn_id="resp_2", title="New", created_at=1_700_000_100)
    recent = store.list_recent(actor=ALICE, limit=10)
    assert [e.title for e in recent] == ["New", "Old"]


def test_list_recent_respects_limit(store: SqlAlchemyEpisodeStore) -> None:
    for i in range(5):
        _upsert(store, turn_id=f"resp_{i}", created_at=1_700_000_000 + i)
    assert len(store.list_recent(actor=ALICE, limit=3)) == 3


def test_list_recent_scoped_to_owner(store: SqlAlchemyEpisodeStore) -> None:
    # Distinct session ids: a session (and so its turns) has exactly one
    # owner in practice.
    _upsert(store, actor=ALICE, session_id="conv_alice", turn_id="resp_1", title="Alice's")
    _upsert(store, actor=BOB, session_id="conv_bob", turn_id="resp_1", title="Bob's")
    alice_episodes = store.list_recent(actor=ALICE, limit=10)
    assert [e.title for e in alice_episodes] == ["Alice's"]


def test_list_recent_empty(store: SqlAlchemyEpisodeStore) -> None:
    assert store.list_recent(actor=ALICE, limit=10) == []


# ── delete ───────────────────────────────────────────────────────────────────


def test_delete_removes_an_owned_episode(store: SqlAlchemyEpisodeStore) -> None:
    episode = _upsert(store)
    assert store.delete(episode.id, actor=ALICE) is True
    assert store.list_recent(actor=ALICE, limit=10) == []


def test_delete_is_idempotent(store: SqlAlchemyEpisodeStore) -> None:
    episode = _upsert(store)
    assert store.delete(episode.id, actor=ALICE) is True
    assert store.delete(episode.id, actor=ALICE) is False


def test_delete_scoped_to_owner(store: SqlAlchemyEpisodeStore) -> None:
    episode = _upsert(store, actor=ALICE)
    assert store.delete(episode.id, actor=BOB) is False
    assert len(store.list_recent(actor=ALICE, limit=10)) == 1


def test_delete_missing_returns_false(store: SqlAlchemyEpisodeStore) -> None:
    assert store.delete("0" * 32, actor=ALICE) is False
