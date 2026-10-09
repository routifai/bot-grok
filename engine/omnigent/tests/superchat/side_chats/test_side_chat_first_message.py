"""``POST .../side_chats``' first message: one bounded retry, never a doubled message."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from omnigent.entities import MessageData, NewConversationItem
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.side_chats import routes

TEXT = "what is in this file?"


def _resp(status: int, code: str | None = None) -> httpx.Response:
    body: dict[str, Any] = {"queued": True} if status < 400 else {"error": {"code": code}}
    return httpx.Response(status, json=body)


@pytest.fixture(autouse=True)
def _no_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "FIRST_MESSAGE_RETRY_DELAY_S", 0)


def _script(
    monkeypatch: pytest.MonkeyPatch,
    outcomes: list[Any],
    on_call: Any = None,
) -> list[str]:
    calls: list[str] = []

    async def fake(_request: Any, method: str, path: str, _body: dict[str, Any]) -> httpx.Response:
        calls.append(f"{method} {path}")
        if on_call is not None:
            on_call()
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(routes, "_internal_call", fake)
    return calls


async def _deliver(store: SqlAlchemyConversationStore, chat_id: str) -> tuple[Any, Any]:
    return await routes._deliver_first_message(None, store, chat_id, TEXT)  # type: ignore[arg-type]


async def test_retries_once_after_a_retryable_failure(
    monkeypatch: pytest.MonkeyPatch, conversation_store: SqlAlchemyConversationStore
) -> None:
    chat = conversation_store.create_conversation(kind="default", title="Side")
    calls = _script(monkeypatch, [_resp(503, "runner_unavailable"), _resp(202)])
    assert await _deliver(conversation_store, chat.id) == (None, None)
    assert len(calls) == 2


async def test_gives_up_after_the_one_retry_with_the_code(
    monkeypatch: pytest.MonkeyPatch, conversation_store: SqlAlchemyConversationStore
) -> None:
    chat = conversation_store.create_conversation(kind="default", title="Side")
    calls = _script(monkeypatch, [httpx.ConnectError("x"), _resp(503, "runner_unavailable")])
    error, code = await _deliver(conversation_store, chat.id)
    assert code == "runner_unavailable" and "503" in error
    assert len(calls) == 2


async def test_a_permanent_failure_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, conversation_store: SqlAlchemyConversationStore
) -> None:
    chat = conversation_store.create_conversation(kind="default", title="Side")
    calls = _script(monkeypatch, [_resp(400, "invalid_input")])
    assert (await _deliver(conversation_store, chat.id))[1] == "invalid_input"
    assert len(calls) == 1


async def test_a_message_stored_before_the_failure_is_never_posted_twice(
    monkeypatch: pytest.MonkeyPatch, conversation_store: SqlAlchemyConversationStore
) -> None:
    chat = conversation_store.create_conversation(kind="default", title="Side")

    def store_it() -> None:
        conversation_store.append(
            chat.id,
            [
                NewConversationItem(
                    type="message",
                    response_id="turn_1",
                    data=MessageData(role="user", content=[{"type": "input_text", "text": TEXT}]),
                )
            ],
        )

    calls = _script(monkeypatch, [_resp(503, "runner_unavailable")], on_call=store_it)
    assert (await _deliver(conversation_store, chat.id))[1] == "runner_unavailable"
    assert len(calls) == 1
    assert len(conversation_store.list_items(chat.id).data) == 1
