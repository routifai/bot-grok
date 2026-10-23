"""Tests for :class:`SqlAlchemyTopicStore`: upsert by key, cleaning, event merge, the window."""

from __future__ import annotations

from zoneinfo import ZoneInfo

import pytest

from omnigent.superchat.topics.store import SqlAlchemyTopicStore

UTC = ZoneInfo("UTC")
NOW = 1_792_000_000  # 2026-10-14 17:46 UTC
DAY = 86400


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyTopicStore:
    return SqlAlchemyTopicStore(db_uri)


def test_upsert_cleans_trims_and_merges_events(store: SqlAlchemyTopicStore) -> None:
    first = store.update(
        "alice",
        [
            {
                "key": "Polaris Launch!",
                "title": "Polaris launch plan for the whole team",
                "left_off": "Waiting on legal.",
                "covered": [
                    {"date": "2026-10-14", "kind": "Decided", "text": "Ship Friday"},
                    {"date": "2026-10-14", "kind": "Wondered", "text": "dropped"},
                ],
                "open": [{"kind": "Promised", "text": "Send the deck"}] * 6,
                "starters": ["Draft the note", "draft the note", "Check legal", "Plan QA", "x"],
                "events": [{"at": NOW - DAY, "line": "Decided to ship Friday"}],
                "sources": {"chats": 3, "files": -2, "emails": True},
                "watch": {"people": ["dana@x.com"], "terms": [f"t{i}" for i in range(12)]},
            },
            {"key": "orphan", "left_off": "no title"},
        ],
        zone=UTC,
        now=NOW,
    )
    assert first["written"] == [{"key": "polaris-launch", "created": True}]
    assert first["skipped"] == [{"key": "orphan", "reason": "a new topic needs a title"}]
    topic = store.get("alice", "polaris-launch")
    assert topic is not None
    assert topic.title == "Polaris launch plan for the"
    assert [c["kind"] for c in topic.covered] == ["Decided"]
    assert len(topic.open) == 4
    assert topic.starters == ["Draft the note", "Check legal", "Plan QA"]
    assert topic.sources == {"chats": 3, "files": 0}
    assert len(topic.watch["terms"]) == 8 and topic.watch["web"] is False
    assert topic.last_touched_at == NOW - DAY

    second = store.update(
        "alice",
        [
            {
                "key": "polaris-launch",
                "left_off": "Legal signed off.",
                "events": [
                    {
                        "at": NOW - DAY + 60,
                        "line": "decided to ship  friday",
                    },  # same day, same line
                    {"at": "2026-10-14T16:30", "line": "Legal signed off"},
                    *({"at": NOW - 3 * DAY - i, "line": f"older {i}"} for i in range(14)),
                ],
            }
        ],
        zone=UTC,
        now=NOW,
    )
    assert second["written"] == [{"key": "polaris-launch", "created": False}]
    topic = store.get("alice", "polaris-launch")
    assert topic is not None
    assert topic.title == "Polaris launch plan for the"  # kept: not passed
    assert topic.left_off == "Legal signed off."
    assert len(topic.events) == 12
    assert topic.events[0]["line"] == "Legal signed off"
    assert sum(1 for e in topic.events if "friday" in e["line"].lower()) == 1
    assert topic.last_touched_at == topic.events[0]["at"]


def test_window_closed_and_mark_new(store: SqlAlchemyTopicStore) -> None:
    for key, at in (("fresh", NOW - DAY), ("stale", NOW - 8 * DAY), ("done", NOW - DAY)):
        store.update(
            "alice",
            [{"key": key, "title": key, "events": [{"at": at, "line": key}]}],
            zone=UTC,
            now=NOW,
        )
    store.update("alice", [{"key": "done", "status": "closed"}], zone=UTC, now=NOW)
    assert [t.key for t in store.list_recent("alice", now=NOW)] == ["fresh"]
    assert store.list_recent("alice", days=30, now=NOW)[0].key == "fresh"  # never past 7 days
    assert store.get("alice", "stale") is not None  # kept, just not listed
    assert store.list_recent("bob", now=NOW) == []

    assert store.mark_new("alice", "fresh", "Dana replied", NOW)
    assert not store.mark_new("alice", "missing", "x", NOW)
    topic = store.get("alice", "fresh")
    assert topic is not None and topic.since == "Dana replied" and topic.since_at == NOW
