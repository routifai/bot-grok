"""Tests for the Omnigent elicitation bridge (``bridge.py``).

Fakes the Omnigent pieces the bridge reaches into — the ambient
``ConversationStore`` (via a stand-in) and the runner/session-dispatch layer
(by patching the bridge's own ``_resolve_live`` / ``_post_as_message`` seams)
— but exercises the REAL ``pending_elicitations`` in-process index, since
that index's own lifecycle (cleared here between tests, gone for good on a
real restart) is exactly what distinguishes "still live" from "after
restart".
"""

from __future__ import annotations

from typing import Any

import pytest

from omnigent.nova.asks import bridge
from omnigent.nova.asks.entities import Ask, AskKind, AskStatus
from omnigent.nova.asks.service import AskService
from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore
from omnigent.runtime import pending_elicitations

from ._fakes import FakeConversationStore, uid

ALICE = "alice@example.com"
CONV_1 = uid("conv_1")


@pytest.fixture(autouse=True)
def _reset_pending_elicitations() -> Any:
    pending_elicitations.reset_for_tests()
    yield
    pending_elicitations.reset_for_tests()


@pytest.fixture()
def conversation_store(db_uri: str) -> FakeConversationStore:
    return FakeConversationStore(storage_location=db_uri)


@pytest.fixture()
def _patched_conversation_store(
    monkeypatch: pytest.MonkeyPatch, conversation_store: FakeConversationStore
) -> FakeConversationStore:
    """Point every ambient lookup (bridge.py, _runtime_store/_service) at the fake."""
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: conversation_store)
    # _runtime_store() caches the Ask store for the process; bypass that
    # cache directly so each test gets its own db_uri (see test_tools.py).
    from omnigent.nova import asks as _asks

    monkeypatch.setattr(
        _asks, "_runtime_store", lambda: SqlAlchemyAskStore(conversation_store.storage_location)
    )
    return conversation_store


def _elicitation_event(
    elicitation_id: str, message: str = "Approve running rm?"
) -> dict[str, Any]:
    return {
        "type": "response.elicitation_request",
        "elicitation_id": elicitation_id,
        "params": {"message": message},
    }


# ── on_session_event: mirroring a request into an Ask ───────────────────


def test_private_session_elicitation_becomes_an_ask(
    _patched_conversation_store: FakeConversationStore,
) -> None:
    store = _patched_conversation_store
    store.owners[CONV_1] = ALICE
    store.labels[CONV_1] = {"nova.scope": "private"}

    bridge.on_session_event(CONV_1, _elicitation_event("elicit_1", "Approve deploy?"))

    ask_store = SqlAlchemyAskStore(store.storage_location)
    ask = ask_store.get_by_elicitation("elicit_1")
    assert ask is not None
    assert ask.user_id == ALICE
    assert ask.session_id == CONV_1
    assert ask.kind is AskKind.APPROVAL
    assert ask.text == "Approve deploy?"
    assert {a.id for a in ask.actions} == {"accept", "decline"}


def test_project_session_elicitation_is_ignored(
    _patched_conversation_store: FakeConversationStore,
) -> None:
    store = _patched_conversation_store
    store.owners["conv_1"] = ALICE
    store.labels["conv_1"] = {"nova.scope": "project"}

    bridge.on_session_event("conv_1", _elicitation_event("elicit_1"))

    assert SqlAlchemyAskStore(store.storage_location).get_by_elicitation("elicit_1") is None


def test_non_elicitation_event_is_ignored(
    _patched_conversation_store: FakeConversationStore,
) -> None:
    store = _patched_conversation_store
    store.owners["conv_1"] = ALICE
    store.labels["conv_1"] = {"nova.scope": "private"}

    bridge.on_session_event("conv_1", {"type": "response.output_text.delta", "delta": "hi"})

    assert SqlAlchemyAskStore(store.storage_location).get_by_elicitation("elicit_1") is None


def test_republished_elicitation_does_not_duplicate_the_ask(
    _patched_conversation_store: FakeConversationStore,
) -> None:
    store = _patched_conversation_store
    store.owners[CONV_1] = ALICE
    store.labels[CONV_1] = {"nova.scope": "private"}

    event = _elicitation_event("elicit_1")
    bridge.on_session_event(CONV_1, event)
    bridge.on_session_event(CONV_1, event)  # a harness reconnect replaying the same request

    service = AskService(SqlAlchemyAskStore(store.storage_location))
    from omnigent.nova._shared import NovaActor

    assert len(service.list_open(NovaActor(user_id=ALICE, workspace_id=0))) == 1


def test_unknown_conversation_does_not_raise(
    _patched_conversation_store: FakeConversationStore,
) -> None:
    # No owner registered for "conv_missing" — on_session_event must degrade
    # quietly (it runs on the hot SSE publish path and must never raise).
    bridge.on_session_event("conv_missing", _elicitation_event("elicit_1"))


# ── on_answered: still live vs. after restart ───────────────────────────


def _ask_row(**overrides: object) -> Ask:
    from omnigent.nova._shared import new_id, now_s

    defaults: dict[str, object] = {
        "id": new_id(),
        "workspace_id": 0,
        "user_id": ALICE,
        "session_id": "conv_1",
        "kind": AskKind.APPROVAL,
        "text": "Approve?",
        "detail": None,
        "actions": (),
        "status": AskStatus.ANSWERED,
        "answer": "accept",
        "elicitation_id": "elicit_1",
        "goal_id": None,
        "task_id": None,
        "created_at": now_s(),
        "answered_at": now_s(),
    }
    defaults.update(overrides)
    return Ask(**defaults)  # type: ignore[arg-type]


async def test_on_answered_resolves_live_elicitation(monkeypatch: pytest.MonkeyPatch) -> None:
    pending_elicitations.record_publish("conv_1", _elicitation_event("elicit_1"))
    resolved: list[tuple[Ask, str]] = []
    posted: list[tuple[Ask, str]] = []

    async def fake_resolve_live(ask: Ask, answer_text: str) -> None:
        resolved.append((ask, answer_text))

    async def fake_post_as_message(ask: Ask, answer_text: str) -> None:
        posted.append((ask, answer_text))

    monkeypatch.setattr(bridge, "_resolve_live", fake_resolve_live)
    monkeypatch.setattr(bridge, "_post_as_message", fake_post_as_message)

    ask = _ask_row()
    await bridge.on_answered(ask, "accept")

    assert resolved == [(ask, "accept")]
    assert posted == []


async def test_on_answered_falls_back_to_message_after_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Nothing recorded in pending_elicitations: simulates the server having
    # restarted since the elicitation was raised (see that module's
    # docstring — the index cannot outlive the process).
    resolved: list[tuple[Ask, str]] = []
    posted: list[tuple[Ask, str]] = []

    async def fake_resolve_live(ask: Ask, answer_text: str) -> None:
        resolved.append((ask, answer_text))

    async def fake_post_as_message(ask: Ask, answer_text: str) -> None:
        posted.append((ask, answer_text))

    monkeypatch.setattr(bridge, "_resolve_live", fake_resolve_live)
    monkeypatch.setattr(bridge, "_post_as_message", fake_post_as_message)

    ask = _ask_row()
    await bridge.on_answered(ask, "accept")

    assert posted == [(ask, "accept")]
    assert resolved == []


async def test_on_answered_falls_back_when_elicitation_belongs_to_another_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Same elicitation id, but tracked against a different session than this
    # Ask's — must not be treated as "still live" for this Ask.
    pending_elicitations.record_publish("conv_other", _elicitation_event("elicit_1"))
    posted: list[tuple[Ask, str]] = []

    async def fake_post_as_message(ask: Ask, answer_text: str) -> None:
        posted.append((ask, answer_text))

    monkeypatch.setattr(bridge, "_resolve_live", lambda *a: pytest.fail("must not resolve live"))
    monkeypatch.setattr(bridge, "_post_as_message", fake_post_as_message)

    ask = _ask_row(session_id="conv_1")
    await bridge.on_answered(ask, "accept")

    assert posted == [(ask, "accept")]


async def test_on_answered_is_a_no_op_for_a_nova_originated_ask(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An Ask with no elicitation_id (a tool question, not a mirrored elicitation)."""
    calls: list[str] = []
    monkeypatch.setattr(bridge, "_resolve_live", lambda *a: calls.append("resolve"))
    monkeypatch.setattr(bridge, "_post_as_message", lambda *a: calls.append("post"))

    ask = _ask_row(elicitation_id=None)
    await bridge.on_answered(ask, "accept")

    assert calls == []


# ── _post_as_message: cold fallback actually persists the answer ───────


async def test_post_as_message_persists_when_no_runner_is_connected(
    monkeypatch: pytest.MonkeyPatch, _patched_conversation_store: FakeConversationStore
) -> None:
    store = _patched_conversation_store
    store.owners["conv_1"] = ALICE

    monkeypatch.setattr(
        "omnigent.server.routes._sessions.common.get_server_runner_router", lambda: None
    )

    async def no_runner_client(*args: object, **kwargs: object) -> None:
        return None

    monkeypatch.setattr(
        "omnigent.server.routes._sessions.helpers._get_runner_client", no_runner_client
    )

    ask = _ask_row()
    await bridge._post_as_message(ask, "accept")

    assert len(store.appended) == 1
    conversation_id, items = store.appended[0]
    assert conversation_id == "conv_1"
    assert items[0].data.content == [{"type": "input_text", "text": "accept"}]
    assert items[0].created_by == ALICE
