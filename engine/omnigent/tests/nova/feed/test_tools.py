"""Tests for the feed built-in tools.

Stubs ``omnigent.runtime.get_conversation_store`` so these run without a real
Omnigent server, exercising real store round-trips through a SQLite `db_uri`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest

from omnigent.nova._shared.scope import SCOPE_LABEL, Scope
from omnigent.nova.feed import tools as feed_tools
from omnigent.tools.base import ToolContext

OWNER = "alice@example.com"


@dataclass
class _FakeConversation:
    labels: dict[str, str] = field(default_factory=dict)


class _FakeConversationStore:
    """Enough of ``ConversationStore`` for ``tools._resolve`` to work."""

    def __init__(self, storage_location: str, *, owner: str | None, scope: Scope) -> None:
        self.storage_location = storage_location
        self._owner = owner
        self._conversation = _FakeConversation(labels={SCOPE_LABEL: scope.value})

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del conversation_id, owner_only
        return self._owner

    def get_conversation(self, conversation_id: str) -> _FakeConversation | None:
        del conversation_id
        return self._conversation


def _ctx(conversation_id: str | None = "conv_abc123") -> ToolContext:
    return ToolContext(task_id="task_1", agent_id="agent_1", conversation_id=conversation_id)


def _patch_store(
    monkeypatch: pytest.MonkeyPatch,
    db_uri: str,
    *,
    owner: str | None = OWNER,
    scope: Scope = Scope.PRIVATE,
) -> None:
    fake = _FakeConversationStore(db_uri, owner=owner, scope=scope)
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: fake)


# ── nova_follow_topic / nova_unfollow_topic ─────────────────────────────────


def test_follow_topic_creates_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaFollowTopicTool()
    result = tool.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    assert "Now following" in result
    again = tool.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    assert "Now following" in again


def test_follow_topic_missing_argument(monkeypatch: pytest.MonkeyPatch, db_uri: str) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaFollowTopicTool()
    result = tool.invoke(json.dumps({}), _ctx())
    assert "required" in result.lower()


def test_follow_topic_refuses_outside_private_scope(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    _patch_store(monkeypatch, db_uri, scope=Scope.PROJECT)
    tool = feed_tools.NovaFollowTopicTool()
    result = tool.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    assert "private" in result.lower()


def test_follow_topic_refuses_without_owner(monkeypatch: pytest.MonkeyPatch, db_uri: str) -> None:
    _patch_store(monkeypatch, db_uri, owner=None)
    tool = feed_tools.NovaFollowTopicTool()
    result = tool.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    assert "no owner" in result.lower()


def test_follow_topic_refuses_without_conversation(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaFollowTopicTool()
    result = tool.invoke(json.dumps({"topic": "AI in banking"}), _ctx(conversation_id=None))
    assert "no active session" in result.lower()


def test_unfollow_topic_round_trip(monkeypatch: pytest.MonkeyPatch, db_uri: str) -> None:
    _patch_store(monkeypatch, db_uri)
    follow = feed_tools.NovaFollowTopicTool()
    unfollow = feed_tools.NovaUnfollowTopicTool()
    follow.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    result = unfollow.invoke(json.dumps({"topic": "AI in banking"}), _ctx())
    assert "Stopped following" in result


def test_unfollow_topic_not_found(monkeypatch: pytest.MonkeyPatch, db_uri: str) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaUnfollowTopicTool()
    result = tool.invoke(json.dumps({"topic": "Never followed"}), _ctx())
    assert "Not following" in result


# ── nova_post_to_feed ────────────────────────────────────────────────────


def test_post_to_feed_success(monkeypatch: pytest.MonkeyPatch, db_uri: str) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaPostToFeedTool()
    result = tool.invoke(
        json.dumps(
            {
                "title": "Rates moved",
                "body": "A thing happened.",
                "source_url": "https://example.com",
            }
        ),
        _ctx(),
    )
    assert "Posted" in result


def test_post_to_feed_requires_valid_source_url(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    _patch_store(monkeypatch, db_uri)
    tool = feed_tools.NovaPostToFeedTool()
    result = tool.invoke(
        json.dumps({"title": "t", "body": "b", "source_url": "not-a-url"}),
        _ctx(),
    )
    assert result.startswith("Error:")


def test_post_to_feed_refuses_outside_private_scope(
    monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    _patch_store(monkeypatch, db_uri, scope=Scope.PROJECT)
    tool = feed_tools.NovaPostToFeedTool()
    result = tool.invoke(
        json.dumps({"title": "t", "body": "b", "source_url": "https://example.com"}),
        _ctx(),
    )
    assert "private" in result.lower()


# ── schema sanity ────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "tool_cls,expected_name",
    [
        (feed_tools.NovaFollowTopicTool, "nova_follow_topic"),
        (feed_tools.NovaUnfollowTopicTool, "nova_unfollow_topic"),
        (feed_tools.NovaPostToFeedTool, "nova_post_to_feed"),
    ],
)
def test_tool_name_matches_registry_key(tool_cls: type, expected_name: str) -> None:
    assert tool_cls.name() == expected_name
    assert expected_name in feed_tools.TOOLS
    schema = tool_cls().get_schema()
    assert schema["function"]["name"] == expected_name
