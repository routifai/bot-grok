"""Tests for the ``nova_offer_skill`` / ``nova_save_skill`` / ``nova_load_skill`` tools.

Owner resolution and the private-scope refusal are tested against a fake
conversation store (mirrors ``tests/nova/memory/test_tools.py``); the actual
offer/save/load paths run against a real :class:`SqlAlchemySkillStore`.

``nova_offer_skill`` also reads this turn's items to enforce the gate (see
``omnigent.nova.skills.gate``): the fake conversation store's ``list_items``
defaults to a single user message containing an instruction cue and no tool
calls, so a call with ``reason="asked"`` and a real procedure body clears the
gate without needing episode evidence — matching ``ASKED``/``VALID_BODY`` in
``test_service.py``.
"""

from __future__ import annotations

import json

import pytest

from omnigent.entities.conversation import ConversationItem, FunctionCallOutputData, MessageData
from omnigent.entities.pagination import PagedList
from omnigent.nova import skills
from omnigent.nova.skills.entities import OfferKind
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore
from omnigent.nova.skills.tools import (
    TOOLS,
    NovaLoadSkillTool,
    NovaOfferSkillTool,
    NovaSaveSkillTool,
)
from omnigent.tools.base import ToolContext

VALID_BODY = (
    "## Steps\n"
    "1. Do the first thing.\n"
    "2. Do the second thing.\n"
    "3. Do the third thing.\n\n"
    "When to use: whenever this task comes up again.\n"
)


class _FakeConversation:
    def __init__(self, labels: dict[str, str]) -> None:
        self.labels = labels


def _user_message(text: str, *, item_id: str = "msg_user") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="message",
        status="completed",
        response_id="resp_0",
        created_at=1_700_000_000,
        data=MessageData(role="user", content=[{"type": "text", "text": text}]),
    )


# The default fixture for a turn that clears gate rule 1 (no failed tool
# calls) and, combined with reason="asked" below, rule 3 (an actual cue).
_CUE_ITEMS = [_user_message("Please remember how to do this next time.")]


class _FakeConversationStore:
    def __init__(
        self,
        conversations: dict[str, _FakeConversation],
        owners: dict[str, str | None],
        items: list[ConversationItem] | None = None,
    ) -> None:
        self._conversations = conversations
        self._owners = owners
        self._items = items if items is not None else _CUE_ITEMS

    def get_conversation(self, conversation_id: str) -> _FakeConversation | None:
        return self._conversations.get(conversation_id)

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del owner_only
        return self._owners.get(conversation_id)

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
        return PagedList(data=self._items[:limit])


@pytest.fixture()
def wired_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> SqlAlchemySkillStore:
    """Point the tools' runtime store at a real, test-scoped SQLite database."""
    store = SqlAlchemySkillStore(db_uri)
    monkeypatch.setattr(skills, "_runtime_store", lambda: store)
    return store


def _wire_private_session(
    monkeypatch: pytest.MonkeyPatch,
    conversation_id: str = "conv1",
    items: list[ConversationItem] | None = None,
) -> None:
    fake = _FakeConversationStore(
        {conversation_id: _FakeConversation({"nova.scope": "private"})},
        {conversation_id: "alice@example.com"},
        items,
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
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert result["status"] == "offer_shown"


def test_offer_skill_refuses_a_project_scoped_session(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _wire_project_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
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
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
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
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert "error" in result


def _tool_error_output(item_id: str) -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="function_call_output",
        status="completed",
        response_id="resp_1",
        created_at=1_700_000_000,
        data=FunctionCallOutputData(call_id=item_id, output='{"error": "boom"}'),
    )


def test_offer_skill_refuses_after_a_failing_turn(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The motivating bug: several errored tool calls this turn, then a request
    # for something unrelated — the offer must be refused regardless of reason.
    failing_items = [
        *(_tool_error_output(f"call_{i}") for i in range(3)),
        _user_message("Please remember how to do this next time."),
    ]
    _wire_private_session(monkeypatch, items=failing_items)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert "error" in result
    assert "failed_turn" in result["error"]


def test_offer_skill_refuses_reason_asked_without_an_actual_cue(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch, db_uri: str
) -> None:
    # No cue in the message, so the gate falls through to episode evidence —
    # wire a real (empty) episode store rather than the fake conversation
    # store, which has no operational database of its own.
    from omnigent.nova import episodes as _episodes
    from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore

    monkeypatch.setattr(_episodes, "_runtime_store", lambda: SqlAlchemyEpisodeStore(db_uri))
    _wire_private_session(monkeypatch, items=[_user_message("what's the weather like today?")])
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps(
        {"name": "Weekly report", "description": "d", "body": VALID_BODY, "reason": "asked"}
    )
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert "error" in result


def test_offer_skill_surfaces_update_kind_for_a_similar_saved_skill(
    wired_store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.nova._shared import NovaActor

    wired_store.create_skill(
        "a" * 32,
        NovaActor(user_id="alice@example.com", workspace_id=0),
        name="Weekly report",
        description="Summarize the week's engineering progress.",
        content="content",
    )
    _wire_private_session(monkeypatch)
    ctx = ToolContext(task_id="t", agent_id="a", conversation_id="conv1")
    args = json.dumps(
        {
            "name": "Weekly status report",
            "description": "Summarize the week's engineering progress for the team.",
            "body": VALID_BODY,
            "reason": "asked",
        }
    )
    result = json.loads(NovaOfferSkillTool().invoke(args, ctx))
    assert result["status"] == "offer_shown"
    assert result["offer_kind"] == OfferKind.UPDATE.value
    assert result["target_skill"] == "Weekly report"


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
