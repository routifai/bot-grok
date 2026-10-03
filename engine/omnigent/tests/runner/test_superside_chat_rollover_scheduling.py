"""Tests for the runner-side superside-chat rollover scheduling fixes:

1. The threshold rollover (``_schedule_superside_chat_threshold_rollover``)
   runs as a background task, so a turn's completion never waits on the
   summarizer LLM call.
2. A warm-client drop that would land while a DIFFERENT turn is active
   (``_drop_superside_chat_warm_client``) is deferred (recorded in
   ``_superside_chat_pending_refresh``) rather than releasing the harness
   subprocess out from under that turn, and is applied at the start of the
   session's next turn (``_consume_superside_chat_pending_refresh``).
3. The next turn waits (bounded) for an in-flight rollover of the same
   session before dispatching, so it never runs on pre-rollover state.

No DB, no server, no live LLM calls — the harness, the Omnigent server
client, and the summarizer LLM client are all tiny in-memory fakes.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

import pytest

from omnigent.llms.types import MessageOutput, OutputText, Response
from omnigent.runner import create_runner_app
from tests.runner.conftest import (
    _FakeProcessManager,
    _runner_client,
    _ScriptedHarnessClient,
    _sse,
)
from tests.runner.helpers import NullServerClient

_SUPERSIDE_LABELS = {"omnigent.context.mode": "superside-chat"}


async def _wait_until(
    predicate: Callable[[], bool], *, timeout: float = 2.0, interval: float = 0.01
) -> None:
    """Poll *predicate* until it's true, or raise after *timeout* seconds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


def _history_items() -> list[dict[str, Any]]:
    """One user/assistant turn, timestamped now (keeps idle-refresh quiet)."""
    now = int(time.time())
    return [
        {
            "id": "u1",
            "type": "message",
            "status": "completed",
            "response_id": "r1",
            "created_at": now,
            "role": "user",
            "content": [{"type": "input_text", "text": "question"}],
        },
        {
            "id": "a1",
            "type": "message",
            "status": "completed",
            "response_id": "r1",
            "created_at": now,
            "role": "assistant",
            "content": [{"type": "output_text", "text": "answer"}],
        },
    ]


def _idle_history_items(idle_seconds: int) -> list[dict[str, Any]]:
    """One user/assistant turn, timestamped *idle_seconds* in the past."""
    stale = int(time.time()) - idle_seconds
    return [
        {
            "id": "u1",
            "type": "message",
            "status": "completed",
            "response_id": "r1",
            "created_at": stale,
            "role": "user",
            "content": [{"type": "input_text", "text": "question"}],
        },
        {
            "id": "a1",
            "type": "message",
            "status": "completed",
            "response_id": "r1",
            "created_at": stale,
            "role": "assistant",
            "content": [{"type": "output_text", "text": "answer"}],
        },
    ]


class _ThresholdServerClient(NullServerClient):
    """Answers ``/labels`` and ``/items``; records posted compaction events."""

    def __init__(self, *, labels: dict[str, str], items: list[dict[str, Any]]) -> None:
        self._labels = labels
        self._items = items
        self.posted_compactions: list[dict[str, Any]] = []

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        labels, items = self._labels, self._items
        if url.endswith("/labels"):

            class _LabelsResponse(NullServerClient._Response):
                def json(self) -> dict[str, Any]:
                    return {"labels": labels}

            return _LabelsResponse()
        if url.endswith("/items"):

            class _ItemsResponse(NullServerClient._Response):
                def json(self) -> dict[str, Any]:
                    return {"data": items, "has_more": False}

            return _ItemsResponse()
        return await super().get(url, **kwargs)

    async def post(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if url.endswith("/events"):
            body = kwargs.get("json", {})
            if isinstance(body, dict) and body.get("type") == "compaction":
                self.posted_compactions.append(body)
        return await super().post(url, **kwargs)


class _GatedLLMClient:
    """Summarizer stub whose ``responses.create`` blocks on *gate*."""

    def __init__(self, gate: asyncio.Event, text: str = "ROLLING SUMMARY") -> None:
        self._gate = gate
        self._text = text
        self.call_count = 0

    class _Responses:
        def __init__(self, outer: _GatedLLMClient) -> None:
            self._outer = outer

        async def create(self, **_kwargs: Any) -> Response:
            self._outer.call_count += 1
            await self._outer._gate.wait()
            return Response(
                output=[MessageOutput(content=[OutputText(text=self._outer._text)])],
                model="test-model",
            )

    @property
    def responses(self) -> _GatedLLMClient._Responses:
        return self._Responses(self)


class _SequencedHarnessClient(_ScriptedHarnessClient):
    """Streams a different scripted SSE sequence for each successive turn."""

    def __init__(self, frame_sequences: list[list[str]]) -> None:
        super().__init__([])
        self._sequences = frame_sequences
        self.call_count = 0

    def stream(self, method: str, url: str, *, json: dict[str, Any], timeout: Any) -> Any:
        del method, url, timeout
        self.posted_bodies.append(json)
        idx = min(self.call_count, len(self._sequences) - 1)
        frames = self._sequences[idx]
        self.call_count += 1

        class _Ctx:
            status_code = 200

            async def __aenter__(self_inner) -> Any:
                return _ScriptedHarnessClient._StreamHandle(frames, None)

            async def __aexit__(self_inner, *_: Any) -> None:
                return None

        return _Ctx()


def _triggering_frames(context_tokens: int) -> list[str]:
    return [
        _sse({"type": "response.created", "response": {"id": "resp_trigger"}}),
        _sse(
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_trigger",
                    "usage": {"context_tokens": context_tokens, "model": "claude-test"},
                },
            }
        ),
    ]


def _plain_frames(resp_id: str = "resp_plain") -> list[str]:
    return [
        _sse({"type": "response.created", "response": {"id": resp_id}}),
        _sse(
            {
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "usage": {"context_tokens": 10, "model": "claude-test"},
                },
            }
        ),
    ]


def _build_app(
    harness_client: _ScriptedHarnessClient, server_client: _ThresholdServerClient
) -> tuple[Any, _FakeProcessManager]:
    pm = _FakeProcessManager(harness_client)
    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        server_client=server_client,  # type: ignore[arg-type]
    )
    return app, pm


async def _post_turn(client: Any, conv_id: str, text: str) -> Any:
    """POST a turn on the DEFAULT (background) path — no ``?stream=true``."""
    return await client.post(
        f"/v1/sessions/{conv_id}/events",
        json={
            "type": "message",
            "role": "user",
            "model": "test-agent",
            "content": [{"type": "input_text", "text": text}],
            "harness": "claude-sdk",
        },
    )


@pytest.mark.asyncio
async def test_threshold_rollover_does_not_block_the_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    """A turn whose usage crosses the threshold finishes without waiting on the summarizer."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _ThresholdServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000)])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_block"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202

        # The turn itself finishes promptly — its own slot clears — even
        # though the rollover's summarizer call is gated and never released
        # here. If the rollover were awaited inline, this would time out.
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        rollover_task = app.state.superside_chat_rollover_tasks.get(conv_id)
        assert rollover_task is not None
        assert not rollover_task.done()

        # Clean up: release the gate and let the background rollover finish.
        gate.set()
        await asyncio.wait_for(rollover_task, timeout=5.0)

    assert len(server_client.posted_compactions) == 1
    assert pm.released == [conv_id]


@pytest.mark.asyncio
async def test_release_deferred_while_turn_active_applied_at_next_turn_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """on_rolled_over defers its release if a turn is active; the next turn applies it."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _ThresholdServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000), _plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_defer"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        rollover_task = app.state.superside_chat_rollover_tasks[conv_id]
        assert not rollover_task.done()

        # Simulate another turn becoming active for this session right as
        # the rollover is about to finish.
        app.state.active_turns[conv_id] = None

        gate.set()
        await asyncio.wait_for(rollover_task, timeout=5.0)

        # The compaction item was built and posted, but the warm-client drop
        # must NOT have released the subprocess out from under the "active"
        # turn — it's deferred instead.
        assert len(server_client.posted_compactions) == 1
        assert pm.released == []
        assert conv_id in app.state.superside_chat_pending_refresh

        # The simulated turn finishes.
        app.state.active_turns.pop(conv_id, None)

        # The next turn applies the deferred drop at its start, before
        # dispatching to the harness.
        resp2 = await asyncio.wait_for(_post_turn(client, conv_id, "second"), timeout=5.0)
        assert resp2.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

    assert pm.released == [conv_id]
    assert conv_id not in app.state.superside_chat_pending_refresh


@pytest.mark.asyncio
async def test_next_turn_waits_for_an_in_flight_rollover(monkeypatch: pytest.MonkeyPatch) -> None:
    """A turn started while a rollover is in flight waits for it before dispatching."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _ThresholdServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000), _plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_wait"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        rollover_task = app.state.superside_chat_rollover_tasks[conv_id]
        assert not rollover_task.done()
        assert len(harness_client.posted_bodies) == 1

        # Start the next turn while the rollover is still gated. It must
        # claim _active_turns (the POST returns 202) but NOT reach the
        # harness yet — it's waiting on the in-flight rollover task.
        resp2_task = asyncio.create_task(_post_turn(client, conv_id, "second"))
        await _wait_until(lambda: conv_id in app.state.active_turns, timeout=2.0)

        await asyncio.sleep(0.2)
        assert len(harness_client.posted_bodies) == 1, (
            "the second turn dispatched to the harness before the in-flight rollover finished"
        )

        gate.set()
        resp2 = await asyncio.wait_for(resp2_task, timeout=5.0)
        assert resp2.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

    assert len(harness_client.posted_bodies) == 2
    assert pm.released == [conv_id]


class _FlakyThenSuccessLabelsServerClient(_ThresholdServerClient):
    """Every ``/labels`` lookup fails (502) while ``self.failing`` is set;
    all succeed once a test clears it.

    Reproduces a transient label-fetch outage spanning a superside-chat
    session's entire first turn (every lookup that turn makes fails, not
    just one), to prove the runner's rollover-labels cache does not
    permanently remember that outage as "not superside-chat" (the bug: the
    old ``_session_labels_for_runner_spawn`` returned ``{}`` on every
    failure, indistinguishable from a confirmed-empty label set, and that
    ``{}`` got cached forever).
    """

    def __init__(self, *, labels: dict[str, str], items: list[dict[str, Any]]):
        super().__init__(labels=labels, items=items)
        self.failing = True
        self.labels_calls = 0

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if url.endswith("/labels"):
            self.labels_calls += 1
            if self.failing:

                class _FailResponse(NullServerClient._Response):
                    status_code = 502

                return _FailResponse()
        return await super().get(url, **kwargs)


@pytest.mark.asyncio
async def test_transient_labels_failure_does_not_poison_the_rollover_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A session that looked up as "unknown" on one turn must be re-checked
    (not permanently treated as non-superside-chat) on the next."""
    # Left unset: turn 1's rollover check exits early (failed label lookup)
    # without ever reaching the gated summarizer call, so it never blocks on
    # this; turn 2's real rollover call does, and is released explicitly
    # below once it's confirmed in flight — same pattern as the other tests
    # in this file.
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _FlakyThenSuccessLabelsServerClient(
        labels=_SUPERSIDE_LABELS, items=_history_items()
    )
    harness_client = _SequencedHarnessClient(
        [_triggering_frames(500_000), _triggering_frames(500_000)]
    )
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_flaky_labels"

    async with _runner_client(app) as client:
        # First turn: every /labels lookup for this session fails, so the
        # turn must proceed as a non-superside-chat turn — no rollover.
        resp1 = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp1.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        await _wait_until(
            lambda: conv_id not in app.state.superside_chat_rollover_tasks, timeout=2.0
        )
        assert server_client.posted_compactions == []
        assert llm_client.call_count == 0

        # The outage recovers before the next turn.
        server_client.failing = False

        # Second turn: the lookup now succeeds. If the first turn's failures
        # had been cached as "confirmed non-superside-chat", this would also
        # skip the rollover — it must not.
        resp2 = await asyncio.wait_for(_post_turn(client, conv_id, "again"), timeout=5.0)
        assert resp2.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        rollover_task_2 = app.state.superside_chat_rollover_tasks.get(conv_id)
        assert rollover_task_2 is not None
        assert not rollover_task_2.done()

        gate.set()
        await asyncio.wait_for(rollover_task_2, timeout=5.0)

    assert len(server_client.posted_compactions) == 1
    assert pm.released == [conv_id]


# ── ?stream=true is refused for superside-chat sessions ──────────────────


@pytest.mark.asyncio
async def test_stream_true_is_refused_for_superside_chat_session() -> None:
    """The direct-dispatch ``?stream=true`` path never threads context_mode,
    the Memory Profile block, or the idle-refresh/pending-refresh hooks, so
    it must refuse a superside-chat turn rather than silently run it without
    them."""
    server_client = _ThresholdServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_stream_refused"

    async with _runner_client(app) as client:
        resp = await client.post(
            f"/v1/sessions/{conv_id}/events?stream=true",
            json={
                "type": "message",
                "role": "user",
                "model": "test-agent",
                "content": [{"type": "input_text", "text": "hello"}],
                "harness": "claude-sdk",
            },
        )

    assert resp.status_code == 400, resp.text
    assert resp.json()["error"] == "stream_not_supported_for_superside_chat"


@pytest.mark.asyncio
async def test_stream_true_is_allowed_for_a_plain_session() -> None:
    """A non-superside-chat session's ``?stream=true`` turn is unaffected."""
    server_client = _ThresholdServerClient(labels={}, items=_history_items())
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_stream_plain"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(
            client.post(
                f"/v1/sessions/{conv_id}/events?stream=true",
                json={
                    "type": "message",
                    "role": "user",
                    "model": "test-agent",
                    "content": [{"type": "input_text", "text": "hello"}],
                    "harness": "claude-sdk",
                },
            ),
            timeout=5.0,
        )

    assert resp.status_code == 200, resp.text


# ── summarizer model fallback: never the tokenizer-only stand-in ─────────


@pytest.mark.asyncio
async def test_threshold_rollover_skips_when_turn_reports_no_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A turn whose ``response.completed`` carries no ``usage.model`` must
    skip the rollover, not fall back to ROLLOVER_TOKEN_COUNT_MODEL (gpt-4o,
    a tokenizer stand-in never meant for a real summarizer call)."""
    llm_client = _GatedLLMClient(asyncio.Event())
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _ThresholdServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    frames = [
        _sse({"type": "response.created", "response": {"id": "resp_no_model"}}),
        _sse(
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_no_model",
                    # No "model" key at all — the harness didn't report one.
                    "usage": {"context_tokens": 500_000},
                },
            }
        ),
    ]
    harness_client = _SequencedHarnessClient([frames])
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_no_model"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        await _wait_until(
            lambda: conv_id not in app.state.superside_chat_rollover_tasks, timeout=2.0
        )

    assert server_client.posted_compactions == []
    assert llm_client.call_count == 0


@pytest.mark.asyncio
async def test_idle_rollover_skips_when_session_model_unresolvable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A session whose model can't be resolved (``GET /v1/sessions/{id}``
    carries no usable model field) must skip the idle rollover rather than
    summarizing on ROLLOVER_TOKEN_COUNT_MODEL."""
    monkeypatch.setenv("OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS", "10")
    llm_client = _GatedLLMClient(asyncio.Event())
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    # Stale by far more than the 10s idle-refresh threshold above.
    server_client = _ThresholdServerClient(
        labels=_SUPERSIDE_LABELS, items=_idle_history_items(10_000)
    )
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_idle_no_model"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

    assert server_client.posted_compactions == []
    assert llm_client.call_count == 0
