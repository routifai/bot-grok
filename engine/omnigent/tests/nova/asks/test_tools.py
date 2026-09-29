"""Tests for the ``nova_ask_user`` built-in tool.

Fakes the ambient ``ConversationStore`` (the tool has no dependency
injection of its own — see ``omnigent.nova.asks._runtime_store``) and drives
``invoke`` directly, the same way the runner would.
"""

from __future__ import annotations

import json

import pytest

from omnigent.nova.asks.entities import AskKind, AskStatus
from omnigent.nova.asks.service import AskService
from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore
from omnigent.nova.asks.tools import TOOLS, NovaAskUserTool
from omnigent.tools.base import ToolContext

from ._fakes import FakeConversationStore, uid

ALICE = "alice@example.com"
CONV_1 = uid("conv_1")


@pytest.fixture()
def conversation_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> FakeConversationStore:
    store = FakeConversationStore(storage_location=db_uri)
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: store)
    # _runtime_store() caches the Ask store for the process, so patching only
    # the ambient conversation store above would leak whatever a prior test
    # already cached; bypass the cache directly instead (same convention as
    # omnigent.nova.memory._runtime_store's own tests).
    from omnigent.nova import asks as _asks

    monkeypatch.setattr(_asks, "_runtime_store", lambda: SqlAlchemyAskStore(db_uri))
    return store


def _ctx(conversation_id: str | None = CONV_1) -> ToolContext:
    return ToolContext(task_id="t1", agent_id="a1", conversation_id=conversation_id)


def _args(question: str, options: list[str]) -> str:
    return json.dumps({"question": question, "options": options})


# ── factory / schema ─────────────────────────────────────────────────────


def test_registered_under_the_expected_name() -> None:
    assert set(TOOLS) == {"nova_ask_user"}
    tool = TOOLS["nova_ask_user"]({})
    assert isinstance(tool, NovaAskUserTool)
    assert tool.name() == "nova_ask_user"


def test_schema_declares_question_and_options() -> None:
    schema = NovaAskUserTool().get_schema()
    params = schema["function"]["parameters"]["properties"]
    assert params["question"]["maxLength"] == 240
    assert params["options"]["minItems"] == 2
    assert params["options"]["maxItems"] == 4


# ── validation ───────────────────────────────────────────────────────────


def test_rejects_too_few_options(conversation_store: FakeConversationStore) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "private"}
    result = json.loads(NovaAskUserTool().invoke(_args("Pick one", ["Only"]), _ctx()))
    assert "error" in result


def test_rejects_too_many_options(conversation_store: FakeConversationStore) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "private"}
    result = json.loads(
        NovaAskUserTool().invoke(_args("Pick one", ["A", "B", "C", "D", "E"]), _ctx())
    )
    assert "error" in result


def test_rejects_duplicate_options(conversation_store: FakeConversationStore) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "private"}
    result = json.loads(NovaAskUserTool().invoke(_args("Pick one", ["A", "A"]), _ctx()))
    assert "error" in result


def test_rejects_question_over_the_length_cap(conversation_store: FakeConversationStore) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "private"}
    result = json.loads(NovaAskUserTool().invoke(_args("x" * 241, ["A", "B"]), _ctx()))
    assert "error" in result


def test_rejects_malformed_json() -> None:
    result = json.loads(NovaAskUserTool().invoke("not json", _ctx()))
    assert "error" in result


def test_requires_a_session() -> None:
    result = json.loads(NovaAskUserTool().invoke(_args("Pick one", ["A", "B"]), _ctx(None)))
    assert "error" in result


# ── privacy ──────────────────────────────────────────────────────────────


def test_rejects_project_scoped_session(conversation_store: FakeConversationStore) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "project"}
    result = json.loads(NovaAskUserTool().invoke(_args("Pick one", ["A", "B"]), _ctx()))
    assert "error" in result


def test_rejects_unknown_session(conversation_store: FakeConversationStore) -> None:
    result = json.loads(
        NovaAskUserTool().invoke(_args("Pick one", ["A", "B"]), _ctx("conv_missing"))
    )
    assert "error" in result


# ── success path ─────────────────────────────────────────────────────────


def test_valid_call_opens_an_ask_and_tells_model_to_wait(
    conversation_store: FakeConversationStore,
) -> None:
    conversation_store.owners[CONV_1] = ALICE
    conversation_store.labels[CONV_1] = {"nova.scope": "private"}

    result = json.loads(
        NovaAskUserTool().invoke(_args("TypeScript or Python?", ["TypeScript", "Python"]), _ctx())
    )
    assert result["status"] == "waiting_for_answer"

    from omnigent.nova._shared import NovaActor

    asks = AskService(SqlAlchemyAskStore(conversation_store.storage_location)).list_open(
        NovaActor(user_id=ALICE, workspace_id=0)
    )
    assert len(asks) == 1
    ask = asks[0]
    assert ask.kind is AskKind.QUESTION
    assert ask.status is AskStatus.OPEN
    assert ask.session_id == CONV_1
    assert [a.label for a in ask.actions] == ["TypeScript", "Python"]
    assert ask.elicitation_id is None
