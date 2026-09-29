"""Tests for the ``nova_offer_skill`` / ``nova_save_skill`` / ``nova_load_skill`` tools.

Owner resolution and the private-scope refusal are tested against a fake
conversation store (mirrors ``tests/nova/memory/test_tools.py``); the actual
offer/save/load paths run against a real :class:`SqlAlchemySkillStore`.
"""

from __future__ import annotations

import json

import pytest

from omnigent.nova import skills
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore
from omnigent.nova.skills.tools import (
    TOOLS,
    NovaLoadSkillTool,
    NovaOfferSkillTool,
    NovaSaveSkillTool,
)
from omnigent.tools.base import ToolContext


class _FakeConversation:
    def __init__(self, labels: dict[str, str]) -> None:
        self.labels = labels


class _FakeConversationStore:
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
def wired_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> SqlAlchemySkillStore:
    """Point the tools' runtime store at a real, test-scoped SQLite database."""
    store = SqlAlchemySkillStore(db_uri)
    monkeypatch.setattr(skills, "_runtime_store", lambda: store)
    return store


def _wire_private_session(monkeypatch: pytest.MonkeyPatch, conversation_id: str = "conv1") -> None:
    fake = _FakeConversationStore(
        {conversation_id: _FakeConversation({"nova.scope": "private"})},
        {conversation_id: "alice@example.com"},
    )
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: fake)


def _wire_project_session(monkeypatch: pytest.MonkeyPatch, conversation_id: str = "conv1") -> None:
    fake = _FakeConversationStore(
        {conversation_id: _FakeConversation({"nova.scope": "project"})},
        {conversation_id: "alice@example.com"},
    )
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: fake)


def test_all_three_tools_registered() -> None:
    assert set(TOOLS) == {"nova_offer_skill", "nova_save_skill", "nova_load_skill"}
    assert isinstance(TOOLS["nova_offer_skill"]({}), NovaOfferSkillTool)
    assert isinstance(TOOLS["nova_save_skill"]({}), NovaSaveSkillTool)
    assert isinstance(TOOLS["nova_load_skill"]({}), NovaLoadSkillTool)


# ── nova_offer_skill ─────────────────────────────────────────────────────────


def test_offer_skill_in_a_private_session(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert result["status"] == "offer_shown"


def test_offer_skill_refuses_a_project_scoped_session(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_project_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert "error" in result
    assert "private" in result["error"]


def test_offer_skill_rejects_missing_fields(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaOfferSkillTool().invoke("{}", ctx))
    assert "error" in result


def test_offer_skill_does_not_repeat_a_declined_offer(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    tool = NovaOfferSkillTool()
    tool.invoke(args, ctx)

    from omnigent.nova._shared import NovaActor

    offer = wired_store.list_open_offers(NovaActor(user_id="alice@example.com", workspace_id=0))[0]
    from omnigent.nova.skills.entities import OfferStatus

    wired_store.decide_offer(
        NovaActor(user_id="alice@example.com", workspace_id=0),
        offer.id,
        status=OfferStatus.DISMISSED,
    )
    result = json.loads(tool.invoke(args, ctx))
    assert "error" in result


def test_offer_skill_refuses_with_no_conversation_id(
    wired_store: SqlAlchemySkillStore,
) -> None:
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id=None)
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert "error" in result


# ── nova_save_skill ──────────────────────────────────────────────────────────


def test_save_skill_with_name_description_body(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    result = json.loads(NovaSaveSkillTool().invoke(args, ctx))
    assert result["ok"] is True
    assert result["name"] == "Weekly report"


def test_save_skill_with_full_content(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    content = "---\nname: Pasted skill\ndescription: d\n---\n\nSteps.\n"
    result = json.loads(NovaSaveSkillTool().invoke(json.dumps({"content": content}), ctx))
    assert result["ok"] is True
    assert result["name"] == "Pasted skill"


def test_save_skill_refuses_a_project_scoped_session(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_project_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    result = json.loads(NovaSaveSkillTool().invoke(args, ctx))
    assert "error" in result


def test_save_skill_rejects_duplicate_name(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps({"name": "Weekly report", "description": "d", "body": "b"})
    tool = NovaSaveSkillTool()
    tool.invoke(args, ctx)
    result = json.loads(tool.invoke(args, ctx))
    assert "error" in result


# ── nova_load_skill ──────────────────────────────────────────────────────────


def test_load_skill_returns_content(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    NovaSaveSkillTool().invoke(
        json.dumps({"name": "Weekly report", "description": "d", "body": "b"}), ctx
    )
    result = json.loads(NovaLoadSkillTool().invoke(json.dumps({"name": "Weekly report"}), ctx))
    assert result["ok"] is True
    assert "b" in result["content"]


def test_load_skill_unknown_name_errors(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaLoadSkillTool().invoke(json.dumps({"name": "nope"}), ctx))
    assert "error" in result


def test_load_skill_refuses_a_project_scoped_session(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_project_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    result = json.loads(NovaLoadSkillTool().invoke(json.dumps({"name": "x"}), ctx))
    assert "error" in result
