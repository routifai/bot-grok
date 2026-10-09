"""How a message sent to a session is taken: as a turn, steered into the running one, or queued.

The POST answers at once (``delivery``), and ``session.input.delivery`` events, keyed by the
persisted message the server stamped on the forward, follow it: ``queued`` may come first, then
exactly one of ``steer`` / ``turn`` / ``cancelled`` per message.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest

from tests.runner.conftest import _runner_client, _sse
from tests.runner.test_app_sessions_native_workflow_messages import (
    _build_handshake_app,
    _HandshakeHarnessClient,
)

SESSION = "ede98a0180773a70b1e81cc854ff7d8a"
AGENT = "880b5afda28ad55ff74cbeb9b5fc67fb"


def _message(text: str, item_id: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "type": "message",
        "role": "user",
        "model": "test-agent",
        "content": [{"type": "input_text", "text": text}],
        "harness": "openai-agents",
    }
    if item_id:
        body["persisted_item_id"] = item_id
    return body


def _deliveries(app: Any, queue: Any = None) -> list[tuple[str, str]]:
    queue = queue or app.state.session_event_queues.get(SESSION)
    events: list[dict[str, Any]] = []
    while queue is not None and not queue.empty():
        events.append(queue.get_nowait())
    return [
        (e["data"]["item_id"], e["data"]["delivered"])
        for e in events
        if e and e.get("type") == "session.input.delivery"
    ]


class _RefusingHarness(_HandshakeHarnessClient):
    """A harness that cannot take a message into the running turn."""

    def stream(self, method: str, url: str, *, json: dict[str, Any], timeout: Any) -> Any:
        self.posted_bodies.append(json)
        gate, injections = self._gate, self._consumed_ids
        is_first = len(self.posted_bodies) == 1

        class _Ctx:
            status_code = 200

            async def __aenter__(self) -> Any:
                return _Handle()

            async def __aexit__(self, *_: Any) -> None:
                return None

        class _Handle:
            status_code = 200

            async def aiter_text(self) -> AsyncIterator[str]:
                yield _sse({"type": "response.created", "response": {"id": "resp_1"}})
                if is_first:
                    await gate.wait()
                    for inj_id in list(injections):
                        yield _sse({"type": "injection.refused", "injection_id": inj_id})
                yield _sse({"type": "response.completed", "response": {"id": "resp_1"}})

        return _Ctx()


async def _send_during_a_turn(
    app: Any, harness: Any, gate: asyncio.Event, expected_answer: str = "steer"
) -> None:
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        first = await client.post(f"/v1/sessions/{SESSION}/events", json=_message("redo", "i1"))
        assert first.status_code == 202
        await asyncio.sleep(0.05)
        second = await client.post(
            f"/v1/sessions/{SESSION}/events", json=_message("just redo the deck again", "i2")
        )
        assert second.json()["status"] == "buffered"
        assert second.json()["delivery"] == expected_answer
        gate.set()
        for _ in range(100):
            await asyncio.sleep(0.01)
            if len(harness.posted_bodies) >= 2:
                break
        await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_a_message_the_harness_takes_into_the_turn_is_reported_as_steer() -> None:
    gate = asyncio.Event()
    app, _pm, harness = _build_handshake_app(gate)

    await _send_during_a_turn(app, harness, gate)

    assert _deliveries(app) == [("i1", "turn"), ("i2", "steer")]
    assert len(harness.posted_bodies) == 1  # one turn, not two


@pytest.mark.asyncio
async def test_a_message_the_harness_refuses_is_queued_then_runs_as_the_next_turn() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]

    await _send_during_a_turn(app, harness, gate)

    assert _deliveries(app) == [("i1", "turn"), ("i2", "queued"), ("i2", "turn")]
    assert len(harness.posted_bodies) == 2


@pytest.mark.asyncio
async def test_a_message_to_an_idle_session_starts_a_turn_and_says_so() -> None:
    gate = asyncio.Event()
    app, _pm, _harness = _build_handshake_app(gate)
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        answer = await client.post(f"/v1/sessions/{SESSION}/events", json=_message("hi", "i1"))
        gate.set()
    assert (answer.status_code, answer.json()["delivery"]) == (202, "turn")
    assert _deliveries(app) == [("i1", "turn")]


@pytest.mark.asyncio
async def test_a_message_only_for_a_running_turn_is_refused_by_an_idle_session() -> None:
    gate = asyncio.Event()
    app, _pm, harness = _build_handshake_app(gate)
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        body = {**_message("a note for the running turn", "i1"), "if_running": True}
        answer = await client.post(f"/v1/sessions/{SESSION}/events", json=body)
    assert (answer.status_code, answer.json()["error"]) == (409, "not_running")
    assert harness.posted_bodies == []  # no turn was started for it
    assert _deliveries(app) == []


async def _gate_when_forwarded(harness: Any, gate: asyncio.Event) -> None:
    """Let the turn go on once the runner has forwarded the injection to the harness."""
    while not harness.patched_events:
        await asyncio.sleep(0.005)
    gate.set()


@pytest.mark.asyncio
async def test_a_message_only_for_a_running_turn_steers_into_one() -> None:
    gate = asyncio.Event()
    app, _pm, harness = _build_handshake_app(gate)
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        body = {**_message("a note", "i2"), "if_running": True}
        release = asyncio.create_task(_gate_when_forwarded(harness, gate))
        # Answered once the running turn has its verdict on the note, not before.
        answer = await client.post(f"/v1/sessions/{SESSION}/events", json=body)
        await release
        await asyncio.sleep(0.1)
    assert answer.json()["delivery"] == "steer"
    assert "if_running" not in harness.patched_events[-1]
    assert not any(k.startswith("_only") for k in harness.patched_events[-1])
    assert _deliveries(app) == [("i1", "turn"), ("i2", "steer")]


@pytest.mark.asyncio
async def test_a_message_only_for_a_running_turn_that_refuses_it_never_runs() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        body = {**_message("a note", "i2"), "if_running": True}
        release = asyncio.create_task(_gate_when_forwarded(harness, gate))
        answer = await client.post(f"/v1/sessions/{SESSION}/events", json=body)
        await release
        await asyncio.sleep(0.1)
    assert (answer.status_code, answer.json()["error"]) == (409, "not_running")
    assert len(harness.posted_bodies) == 1  # it did not become a turn of its own
    assert not app.state.session_message_buffers.get(SESSION)
    # The sender was told; the server removes the item, so no delivery is reported for it.
    assert _deliveries(app) == [("i1", "turn")]


@pytest.mark.asyncio
async def test_a_message_only_for_a_running_turn_is_refused_when_it_cannot_be_offered() -> None:
    gate = asyncio.Event()
    app, _pm, harness = _build_handshake_app(gate)
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        body = {
            **_message("look", "i2"),
            "content": [{"type": "input_image", "image_url": "data:image/png;base64,AA=="}],
            "if_running": True,
        }
        answer = await client.post(f"/v1/sessions/{SESSION}/events", json=body)
        gate.set()
        await asyncio.sleep(0.1)
    assert (answer.status_code, answer.json()["error"]) == (409, "not_running")
    assert harness.patched_events == []
    assert _deliveries(app) == [("i1", "turn")]


@pytest.mark.asyncio
async def test_a_message_with_an_image_is_not_steered_but_runs_whole_as_a_turn() -> None:
    gate = asyncio.Event()
    app, _pm, harness = _build_handshake_app(gate)
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        image = [
            {"type": "input_text", "text": "what is this?"},
            {"type": "input_image", "image_url": "data:image/png;base64,AA=="},
        ]
        answer = await client.post(
            f"/v1/sessions/{SESSION}/events", json={**_message("x", "i2"), "content": image}
        )
        gate.set()
        for _ in range(100):
            await asyncio.sleep(0.01)
            if len(harness.posted_bodies) >= 2:
                break
    assert answer.json()["delivery"] == "queued"
    assert harness.patched_events == []  # never offered in part
    assert _deliveries(app) == [("i1", "turn"), ("i2", "queued"), ("i2", "turn")]


@pytest.mark.asyncio
async def test_a_stop_cancels_the_messages_waiting_behind_the_turn() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("and this", "i2"))
        await client.post(f"/v1/sessions/{SESSION}/events", json={"type": "interrupt"})
        gate.set()
        await asyncio.sleep(0.1)
    assert ("i2", "cancelled") in _deliveries(app)
    assert len(harness.posted_bodies) == 1  # it did not run after the stop


@pytest.mark.asyncio
async def test_deleting_the_session_cancels_the_messages_still_waiting() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("and this", "i2"))
        stream = app.state.session_event_queues[SESSION]  # closed and dropped by the delete
        await client.delete(f"/v1/sessions/{SESSION}")
    assert _deliveries(app, stream) == [("i1", "turn"), ("i2", "cancelled")]


@pytest.mark.asyncio
async def test_session_init_reports_the_messages_the_runner_still_holds() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]
    async with _runner_client(app) as client:
        first = await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        assert first.json()["held_item_ids"] == []
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("work", "i1"))
        await asyncio.sleep(0.05)
        await client.post(f"/v1/sessions/{SESSION}/events", json=_message("and this", "i2"))
        again = await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        gate.set()
        await asyncio.sleep(0.1)
    assert again.json()["held_item_ids"] == ["i2"]
