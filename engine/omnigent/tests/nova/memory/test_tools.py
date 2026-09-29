"""Tests for the ``nova_remember`` built-in tool.

Owner resolution and the private-scope refusal are tested against a fake
conversation store (Omnigent's session-permission plumbing is out of scope
for this primitive); the actual remember/persist path runs against a real
:class:`SqlAlchemyMemoryStore` so the tool is proven end to end.
"""

from __future__ import annotations

import json

import pytest

from omnigent.nova import memory
from omnigent.nova.memory.sqlalchemy_store import SqlAlchemyMemoryStore
from omnigent.nova.memory.tools import TOOLS, NovaRememberTool
from omnigent.tools.base import ToolContext


class _FakeConversation:
    def __init__(self, labels: dict[str, str]) -> None:
        self.labels = labels


class _FakeConversationStore:
    """Minimal stand-in for ``omnigent.stores.ConversationStore``."""

    def __init__(
        self, conversations: dict[str, _FakeConversation], owners: dict[str, str | None]
    ) -> None:
        self._conversations = conversations
        self._owners = owners

    def get_conversation(self, conversation_id: str) -> _FakeConversation | None:
        return self._conversations.get(conversation_id)

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del owner_only
        return self._owners.get(conversation_id)


@pytest.fixture()
def wired_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> SqlAlchemyMemoryStore:
    """Point the tool's runtime store at a real, test-scoped SQLite database."""
    store = SqlAlchemyMemoryStore(db_uri)
    monkeypatch.setattr(memory, "_runtime_store", lambda: store)
    return store


def _wire_conversations(
    monkeypatch: pytest.MonkeyPatch,
    conversations: dict[str, _FakeConversation],
    owners: dict[str, str | None],
) -> None:
    fake = _FakeConversationStore(conversations, owners)
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: fake)


def test_registered_under_nova_remember() -> None:
    assert "nova_remember" in TOOLS
    assert isinstance(TOOLS["nova_remember"]({}), NovaRememberTool)


def test_remembers_in_a_private_session(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch,
        {"conv1": _FakeConversation({"nova.scope": "private"})},
        {"conv1": "alice@example.com"},
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke('{"content": "Likes tea."}', ctx))
    assert result["ok"] is True
    assert result["revision"] == 1


def test_refuses_a_project_scoped_session(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch,
        {"conv1": _FakeConversation({"nova.scope": "project"})},
        {"conv1": "alice@example.com"},
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke('{"content": "x"}', ctx))
    assert "error" in result
    assert "private" in result["error"]


def test_refuses_an_unlabeled_session(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only an explicit ``nova.scope=private`` is private: an unlabelled
    session (any non-Nova session) can't write to someone's memory."""
    _wire_conversations(
        monkeypatch, {"conv1": _FakeConversation({})}, {"conv1": "alice@example.com"}
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke('{"content": "x"}', ctx))
    assert "private" in result["error"]


def test_refuses_with_no_conversation_id(wired_store: SqlAlchemyMemoryStore) -> None:
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id=None)
    result = json.loads(NovaRememberTool().invoke('{"content": "x"}', ctx))
    assert "error" in result


def test_refuses_unknown_conversation(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(monkeypatch, {}, {})
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="nope")
    result = json.loads(NovaRememberTool().invoke('{"content": "x"}', ctx))
    assert "error" in result


def test_refuses_a_session_with_no_owner(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch, {"conv1": _FakeConversation({"nova.scope": "private"})}, {"conv1": None}
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke('{"content": "x"}', ctx))
    assert "error" in result


def test_rejects_missing_content(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch,
        {"conv1": _FakeConversation({"nova.scope": "private"})},
        {"conv1": "alice@example.com"},
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke("{}", ctx))
    assert "error" in result


def test_rejects_invalid_kind(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch,
        {"conv1": _FakeConversation({"nova.scope": "private"})},
        {"conv1": "alice@example.com"},
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaRememberTool().invoke('{"content": "x", "kind": "not_a_kind"}', ctx))
    assert "error" in result


def test_appends_to_existing_note(
    wired_store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_conversations(
        monkeypatch,
        {"conv1": _FakeConversation({"nova.scope": "private"})},
        {"conv1": "alice@example.com"},
    )
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    tool = NovaRememberTool()
    tool.invoke('{"content": "Likes tea."}', ctx)
    result = json.loads(tool.invoke('{"content": "Likes dark mode."}', ctx))
    assert result["revision"] == 2
