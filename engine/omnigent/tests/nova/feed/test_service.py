"""Tests for :class:`FeedService` domain logic against a real SQLite-backed store."""

from __future__ import annotations

import pytest

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaActor
from omnigent.nova.feed.entities import IdeaDraft
from omnigent.nova.feed.service import (
    MAX_FOLLOWED_TOPICS,
    FeedService,
    digest_schedule,
)
from omnigent.nova.feed.sqlalchemy_store import SqlAlchemyFeedStore

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)


@pytest.fixture()
def service(db_uri: str) -> FeedService:
    return FeedService(SqlAlchemyFeedStore(db_uri))


# ── posts ────────────────────────────────────────────────────────────────


def test_post_topic_requires_valid_source_url(service: FeedService) -> None:
    with pytest.raises(OmnigentError):
        service.post(ACTOR, kind="topic", title="t", body="b", source_url="not-a-url")


def test_post_topic_requires_source_url(service: FeedService) -> None:
    with pytest.raises(OmnigentError):
        service.post(ACTOR, kind="topic", title="t", body="b")


def test_post_goal_report_does_not_require_source_url(service: FeedService) -> None:
    post = service.post(ACTOR, kind="goal_report", title="Shipped the thing", body="Done.")
    assert post.kind == "goal_report"
    assert post.source_url is None


def test_post_rejects_empty_title(service: FeedService) -> None:
    with pytest.raises(OmnigentError):
        service.post(ACTOR, kind="goal_report", title="   ", body="b")


def test_post_trims_and_caps_title(service: FeedService) -> None:
    post = service.post(ACTOR, kind="goal_report", title="  padded  ", body="b")
    assert post.title == "padded"


# ── topics: dedupe and cap ───────────────────────────────────────────────


def test_follow_topic_is_idempotent(service: FeedService) -> None:
    first = service.follow_topic(ACTOR, "AI in banking")
    second = service.follow_topic(ACTOR, "AI in banking")
    assert first.id == second.id
    assert len(service.list_topics(ACTOR)) == 1


def test_follow_topic_rejects_empty(service: FeedService) -> None:
    with pytest.raises(OmnigentError):
        service.follow_topic(ACTOR, "   ")


def test_follow_topic_enforces_cap(service: FeedService) -> None:
    for i in range(MAX_FOLLOWED_TOPICS):
        service.follow_topic(ACTOR, f"topic-{i}")
    with pytest.raises(OmnigentError):
        service.follow_topic(ACTOR, "one-too-many")


def test_unfollow_topic_by_id(service: FeedService) -> None:
    topic = service.follow_topic(ACTOR, "AI in banking")
    assert service.unfollow_topic(ACTOR, topic.id) is True
    assert service.list_topics(ACTOR) == []


def test_unfollow_topic_by_name(service: FeedService) -> None:
    service.follow_topic(ACTOR, "AI in banking")
    assert service.unfollow_topic_by_name(ACTOR, "AI in banking") is True
    assert service.unfollow_topic_by_name(ACTOR, "Not followed") is False


# ── ideas ────────────────────────────────────────────────────────────────


def test_replace_ideas_caps_to_ideas_count(service: FeedService) -> None:
    drafts = [IdeaDraft(text=f"idea {i}", area="misc") for i in range(10)]
    ideas = service.replace_ideas(ACTOR, drafts)
    assert len(ideas) == 6  # IDEAS_COUNT


# ── digest_schedule ──────────────────────────────────────────────────────


def test_digest_schedule_returns_daily_rrule() -> None:
    rrule = digest_schedule("America/Toronto")
    assert rrule == "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"


def test_digest_schedule_rejects_unknown_timezone() -> None:
    with pytest.raises(OmnigentError):
        digest_schedule("Not/AZone")
