"""Tests for :class:`SqlAlchemyFeedStore`.

Exercises posts (create/list/cursor pagination), followed topics
(create/list/count/get-by-name/delete), and ideas (list/replace) against a
real SQLite database.
"""

from __future__ import annotations

import pytest

from omnigent.errors import OmnigentError
from omnigent.nova._shared import new_id
from omnigent.nova.feed.entities import IdeaDraft
from omnigent.nova.feed.sqlalchemy_store import SqlAlchemyFeedStore

OWNER = "alice@example.com"
OTHER = "bob@example.com"


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyFeedStore:
    return SqlAlchemyFeedStore(db_uri)


# ── posts ────────────────────────────────────────────────────────────────


def test_create_post_round_trips(store: SqlAlchemyFeedStore) -> None:
    post = store.create_post(
        new_id(), user_id=OWNER, kind="topic", title="Rates moved", body="A thing happened.",
        source_url="https://example.com/a",
    )
    assert post.user_id == OWNER
    assert post.kind == "topic"
    assert post.title == "Rates moved"
    assert post.source_url == "https://example.com/a"
    assert post.created_at > 0


def test_list_posts_newest_first(
    store: SqlAlchemyFeedStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Force distinct timestamps (created_at has second granularity) so ordering
    # doesn't depend on the id tie-breaker's random uuid4 ordering.
    ticks = iter([1_000, 1_001])
    monkeypatch.setattr("omnigent.nova.feed.sqlalchemy_store.now_epoch", lambda: next(ticks))
    first = store.create_post(new_id(), user_id=OWNER, kind="goal_report", title="A", body="a")
    second = store.create_post(new_id(), user_id=OWNER, kind="goal_report", title="B", body="b")
    page = store.list_posts(user_id=OWNER)
    assert [p.id for p in page.posts] == [second.id, first.id]


def test_list_posts_scoped_to_owner(store: SqlAlchemyFeedStore) -> None:
    store.create_post(new_id(), user_id=OWNER, kind="goal_report", title="Mine", body="x")
    store.create_post(new_id(), user_id=OTHER, kind="goal_report", title="Theirs", body="y")
    page = store.list_posts(user_id=OWNER)
    assert [p.title for p in page.posts] == ["Mine"]


def test_list_posts_pagination_cursor(store: SqlAlchemyFeedStore) -> None:
    for i in range(5):
        store.create_post(new_id(), user_id=OWNER, kind="goal_report", title=f"post-{i}", body="x")
    first_page = store.list_posts(user_id=OWNER, limit=2)
    assert len(first_page.posts) == 2
    assert first_page.next_cursor is not None

    second_page = store.list_posts(user_id=OWNER, cursor=first_page.next_cursor, limit=2)
    assert len(second_page.posts) == 2
    first_ids = {p.id for p in first_page.posts}
    second_ids = {p.id for p in second_page.posts}
    assert first_ids.isdisjoint(second_ids)


def test_list_posts_invalid_cursor_raises(store: SqlAlchemyFeedStore) -> None:
    with pytest.raises(OmnigentError):
        store.list_posts(user_id=OWNER, cursor="not-a-real-cursor")


# ── followed topics ──────────────────────────────────────────────────────


def test_create_topic_round_trips(store: SqlAlchemyFeedStore) -> None:
    topic = store.create_topic(new_id(), user_id=OWNER, topic="AI in banking")
    assert topic.topic == "AI in banking"
    assert topic.user_id == OWNER


def test_list_topics_oldest_first(
    store: SqlAlchemyFeedStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Two real calls can land in the same wall-clock second (created_at has
    # second granularity); force distinct timestamps so ordering is unambiguous
    # rather than depending on the id tie-breaker's random uuid4 ordering.
    ticks = iter([1_000, 1_001])
    monkeypatch.setattr("omnigent.nova.feed.sqlalchemy_store.now_epoch", lambda: next(ticks))
    first = store.create_topic(new_id(), user_id=OWNER, topic="first")
    second = store.create_topic(new_id(), user_id=OWNER, topic="second")
    topics = store.list_topics(user_id=OWNER)
    assert [t.id for t in topics] == [first.id, second.id]


def test_count_topics(store: SqlAlchemyFeedStore) -> None:
    assert store.count_topics(user_id=OWNER) == 0
    store.create_topic(new_id(), user_id=OWNER, topic="a")
    store.create_topic(new_id(), user_id=OWNER, topic="b")
    assert store.count_topics(user_id=OWNER) == 2


def test_get_topic_by_name_scoped_to_owner(store: SqlAlchemyFeedStore) -> None:
    store.create_topic(new_id(), user_id=OWNER, topic="shared name")
    assert store.get_topic_by_name(user_id=OWNER, topic="shared name") is not None
    assert store.get_topic_by_name(user_id=OTHER, topic="shared name") is None


def test_delete_topic_scoped_to_owner(store: SqlAlchemyFeedStore) -> None:
    topic = store.create_topic(new_id(), user_id=OWNER, topic="mine")
    assert store.delete_topic(topic.id, user_id=OTHER) is False
    assert store.delete_topic(topic.id, user_id=OWNER) is True
    assert store.get_topic(topic.id) is None


def test_delete_topic_idempotent(store: SqlAlchemyFeedStore) -> None:
    assert store.delete_topic(new_id(), user_id=OWNER) is False


# ── ideas ────────────────────────────────────────────────────────────────


def test_replace_ideas_returns_in_order(store: SqlAlchemyFeedStore) -> None:
    drafts = [
        IdeaDraft(text="Draft an email", area="work"),
        IdeaDraft(text="Plan a trip", area="travel", detail="Book flights."),
    ]
    ideas = store.replace_ideas(user_id=OWNER, drafts=drafts)
    assert [i.text for i in ideas] == ["Draft an email", "Plan a trip"]
    listed = store.list_ideas(user_id=OWNER)
    assert [i.text for i in listed] == ["Draft an email", "Plan a trip"]


def test_replace_ideas_clears_previous_batch(store: SqlAlchemyFeedStore) -> None:
    store.replace_ideas(user_id=OWNER, drafts=[IdeaDraft(text="Old idea", area="misc")])
    store.replace_ideas(user_id=OWNER, drafts=[IdeaDraft(text="New idea", area="misc")])
    listed = store.list_ideas(user_id=OWNER)
    assert [i.text for i in listed] == ["New idea"]


def test_replace_ideas_scoped_to_owner(store: SqlAlchemyFeedStore) -> None:
    store.replace_ideas(user_id=OWNER, drafts=[IdeaDraft(text="Mine", area="misc")])
    store.replace_ideas(user_id=OTHER, drafts=[IdeaDraft(text="Theirs", area="misc")])
    assert [i.text for i in store.list_ideas(user_id=OWNER)] == ["Mine"]
    assert [i.text for i in store.list_ideas(user_id=OTHER)] == ["Theirs"]
