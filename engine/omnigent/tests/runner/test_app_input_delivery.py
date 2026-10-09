"""How a message sent while a turn runs is taken: steered into it, or queued behind it.

The runner tells clients with ``session.input.delivery`` (``steer`` / ``queued`` / ``turn``),
keyed by the persisted message the server stamped on the forward.
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


def _deliveries(app: Any) -> list[tuple[str, str]]:
    queue = app.state.session_event_queues.get(SESSION)
    events: list[dict[str, Any]] = []
    while queue is not None and not queue.empty():
        events.append(queue.get_nowait())
    return [
        (e["data"]["item_id"], e["data"]["delivered"])
        for e in events
        if e.get("type") == "session.input.delivery"
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


async def _send_during_a_turn(app: Any, harness: Any, gate: asyncio.Event) -> None:
    async with _runner_client(app) as client:
        await client.post("/v1/sessions", json={"session_id": SESSION, "agent_id": AGENT})
        first = await client.post(f"/v1/sessions/{SESSION}/events", json=_message("redo", "i1"))
        assert first.status_code == 202
        await asyncio.sleep(0.05)
        second = await client.post(
            f"/v1/sessions/{SESSION}/events", json=_message("just redo the deck again", "i2")
        )
        assert second.json()["status"] == "buffered"
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

    assert _deliveries(app) == [("i2", "steer")]
    assert len(harness.posted_bodies) == 1  # one turn, not two


@pytest.mark.asyncio
async def test_a_message_the_harness_refuses_is_queued_then_runs_as_the_next_turn() -> None:
    gate = asyncio.Event()
    app, pm, _ = _build_handshake_app(gate)
    harness = _RefusingHarness(gate)
    pm._client = harness  # type: ignore[attr-defined]

    await _send_during_a_turn(app, harness, gate)

    assert _deliveries(app) == [("i2", "queued"), ("i2", "turn")]
    assert len(harness.posted_bodies) == 2
