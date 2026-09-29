"""Tests for the Asks context section (``waiting_on_you``)."""

from __future__ import annotations

import pytest

from omnigent.nova._shared import ContextRequest, NovaActor, Scope
from omnigent.nova.asks.context import context_section
from omnigent.nova.asks.entities import AskAction, AskKind
from omnigent.nova.asks.service import AskService
from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

from ._fakes import FakeConversationStore

ALICE = "alice@example.com"


@pytest.fixture()
def conversation_store(db_uri: str, monkeypatch: pytest.MonkeyPatch) -> FakeConversationStore:
    store = FakeConversationStore(storage_location=db_uri)
    monkeypatch.setattr("omnigent.runtime.get_conversation_store", lambda: store)
    # _runtime_store() caches the Ask store for the process; bypass that
    # cache directly so each test gets its own db_uri (see test_tools.py).
    from omnigent.nova import asks as _asks

    monkeypatch.setattr(_asks, "_runtime_store", lambda: SqlAlchemyAskStore(db_uri))
    return store


def _request(**overrides: object) -> ContextRequest:
    defaults: dict[str, object] = {
        "actor": NovaActor(user_id=ALICE, workspace_id=0),
        "scope": Scope.PRIVATE,
        "session_id": "conv_1",
        "turn_input": "",
        "timezone": "UTC",
        "secrets": (),
    }
    defaults.update(overrides)
    return ContextRequest(**defaults)  # type: ignore[arg-type]


async def test_no_open_asks_returns_none(conversation_store: FakeConversationStore) -> None:
    assert await context_section(_request()) is None


async def test_project_scope_returns_none_even_with_open_asks(
    conversation_store: FakeConversationStore,
) -> None:
    AskService(SqlAlchemyAskStore(conversation_store.storage_location)).open_ask(
        actor=NovaActor(user_id=ALICE, workspace_id=0), kind=AskKind.QUESTION, text="Pick one"
    )
    assert await context_section(_request(scope=Scope.PROJECT)) is None


async def test_open_ask_appears_in_the_section(conversation_store: FakeConversationStore) -> None:
    AskService(SqlAlchemyAskStore(conversation_store.storage_location)).open_ask(
        actor=NovaActor(user_id=ALICE, workspace_id=0),
        kind=AskKind.APPROVAL,
        text="Deploy to prod?",
        actions=(AskAction(id="yes", label="Yes"), AskAction(id="no", label="No")),
    )
    section = await context_section(_request())
    assert section is not None
    assert section.key == "waiting_on_you"
    assert "Deploy to prod?" in section.body
    assert "Yes / No" in section.body


async def test_section_is_scoped_to_the_requesting_actor(
    conversation_store: FakeConversationStore,
) -> None:
    service = AskService(SqlAlchemyAskStore(conversation_store.storage_location))
    service.open_ask(
        actor=NovaActor(user_id="bob@example.com", workspace_id=0),
        kind=AskKind.QUESTION,
        text="For Bob",
    )
    assert await context_section(_request()) is None


async def test_answered_asks_do_not_appear(conversation_store: FakeConversationStore) -> None:
    service = AskService(SqlAlchemyAskStore(conversation_store.storage_location))
    actor = NovaActor(user_id=ALICE, workspace_id=0)
    ask = service.open_ask(actor=actor, kind=AskKind.QUESTION, text="Pick one")
    service.answer(actor, ask.id, "done")
    assert await context_section(_request()) is None
