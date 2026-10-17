"""Tests for the runner-side superside-chat rollover scheduling fixes:

1. The threshold rollover (``_schedule_superside_chat_threshold_rollover``)
   runs as a background task, so a turn's completion never waits on the
   summarizer LLM call.
2. A warm-client drop that would land while a DIFFERENT turn is active
   (``_drop_superside_chat_warm_client``) is deferred (recorded in
   ``_superside_chat_pending_refresh``) rather than releasing the harness
   subprocess out from under that turn, and is applied at the start of the
   session's next turn (``_consume_superside_chat_pending_refresh``).
3. The next turn dispatches without waiting for an in-flight rollover; only
   at the hard context limit does it wait (bounded).
4. At most one rollover task per session at a time.

No DB, no server, no live LLM calls — the harness, the Omnigent server
client, and the summarizer LLM client are all tiny in-memory fakes.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from omnigent.context.rollover import checkpoint_header
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
async def test_next_turn_does_not_wait_below_the_hard_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Below the hard limit the next turn dispatches while the rollover is still gated."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    # 500k fill of a 1M window: over the rollover threshold, under the 95% hard limit.
    labels = {**_SUPERSIDE_LABELS, "omnigent.last_context_window": "1000000"}
    server_client = _ThresholdServerClient(labels=labels, items=_history_items())
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000), _plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_nowait"

    async with _runner_client(app) as client:
        resp = await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        assert resp.status_code == 202
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        rollover_task = app.state.superside_chat_rollover_tasks[conv_id]
        assert not rollover_task.done()

        resp2 = await asyncio.wait_for(_post_turn(client, conv_id, "second"), timeout=5.0)
        assert resp2.status_code == 202
        await _wait_until(lambda: len(harness_client.posted_bodies) == 2, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        assert not rollover_task.done(), "the turn must not have waited for the summarizer"

        gate.set()
        await asyncio.wait_for(rollover_task, timeout=5.0)

    assert len(server_client.posted_compactions) == 1
    # No turn active when the rollover landed: the warm client drops at once.
    assert pm.released == [conv_id]


class _HardLimitServerClient(_ThresholdServerClient):
    """Also answers ``GET /v1/sessions/{id}`` with a model, so a rollover can be scheduled."""

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if url.count("/") == 3 and url.startswith("/v1/sessions/"):

            class _SessionResponse(NullServerClient._Response):
                def json(self) -> dict[str, Any]:
                    return {"llm_model": "claude-test"}

            return _SessionResponse()
        return await super().get(url, **kwargs)


_KEEP_TOKENS = 1_500


def _long_history_items(turns: int = 30) -> list[dict[str, Any]]:
    """*turns* user/assistant turns of about 400 tokens each, timestamped now."""
    now = int(time.time())
    filler = "lorem ipsum dolor sit amet " * 40
    items: list[dict[str, Any]] = []
    for i in range(turns):
        for role, kind in (("user", "input_text"), ("assistant", "output_text")):
            items.append(
                {
                    "id": f"{role[0]}{i}",
                    "type": "message",
                    "status": "completed",
                    "response_id": f"r{i}",
                    "created_at": now,
                    "role": role,
                    "content": [{"type": kind, "text": f"turn {i} {filler}"}],
                }
            )
    return items


def _hard_limit_labels(**extra: str) -> dict[str, str]:
    return {
        **_SUPERSIDE_LABELS,
        "omnigent.last_context_window": "400000",
        "omnigent.context.rollover_keep_tokens": str(_KEEP_TOKENS),
        **extra,
    }


class _FailingLLMClient:
    """Summarizer stub whose call always raises, so a rollover fails."""

    def __init__(self) -> None:
        self.call_count = 0

    class _Responses:
        def __init__(self, outer: _FailingLLMClient) -> None:
            self._outer = outer

        async def create(self, **_kwargs: Any) -> Response:
            self._outer.call_count += 1
            raise RuntimeError("summarizer down")

    @property
    def responses(self) -> _FailingLLMClient._Responses:
        return self._Responses(self)


def _assert_trimmed_to_the_budget(harness_client: _ScriptedHarnessClient, text: str) -> None:
    """The last harness input is a few whole recent turns ending with *text*."""
    from omnigent.runtime.compaction import count_tokens

    content = harness_client.posted_bodies[-1]["content"]
    messages = [m for m in content if m.get("type") == "message"]
    assert len(messages) < 20, "the whole record was sent"
    assert messages[0]["role"] == "user", "a turn was cut in half"
    last_text = " ".join(b["text"] for b in messages[-1]["content"] if "text" in b)
    assert messages[-1]["role"] == "user" and text in last_text
    assert count_tokens(messages[:-1], "gpt-4o") <= _KEEP_TOKENS


@pytest.mark.asyncio
async def test_hard_limit_with_a_rollover_in_flight_trims_and_does_not_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """At/over the hard fraction of the window the next turn neither waits for the
    summarizer nor overflows: it cold-starts on the newest whole turns."""
    gate = asyncio.Event()  # never set until cleanup
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    # 500k fill of a 400k window: dispatching the whole record would overflow.
    server_client = _HardLimitServerClient(
        labels=_hard_limit_labels(), items=_long_history_items()
    )
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000), _plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_inflight"

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        rollover_task = app.state.superside_chat_rollover_tasks[conv_id]
        assert not rollover_task.done()

        await asyncio.wait_for(_post_turn(client, conv_id, "second question"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 2, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

        assert not rollover_task.done(), "the turn must not have waited for the summarizer"
        assert app.state.superside_chat_rollover_tasks[conv_id] is rollover_task
        assert llm_client.call_count == 1
        _assert_trimmed_to_the_budget(harness_client, "second question")
        assert pm.released == [conv_id]

        gate.set()
        await asyncio.wait_for(rollover_task, timeout=5.0)


@pytest.mark.asyncio
async def test_hard_limit_after_a_failed_rollover_trims_and_reschedules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rollover that already failed leaves no task: the turn still does not overflow,
    and the compaction is scheduled again."""
    llm_client = _FailingLLMClient()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _HardLimitServerClient(
        labels=_hard_limit_labels(), items=_long_history_items()
    )
    harness_client = _SequencedHarnessClient([_triggering_frames(500_000), _plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_failed"

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        await _wait_until(
            lambda: conv_id not in app.state.superside_chat_rollover_tasks, timeout=2.0
        )
        assert llm_client.call_count == 1
        assert server_client.posted_compactions == []

        await asyncio.wait_for(_post_turn(client, conv_id, "second question"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 2, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        await _wait_until(lambda: llm_client.call_count == 2, timeout=2.0)

        _assert_trimmed_to_the_budget(harness_client, "second question")
        assert pm.released == [conv_id]


@pytest.mark.asyncio
async def test_hard_limit_with_no_rollover_ever_started_trims_and_schedules(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fill is known only from the session's labels and nothing was ever scheduled."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    server_client = _HardLimitServerClient(
        labels=_hard_limit_labels(**{"omnigent.last_context_tokens": "390000"}),
        items=_long_history_items(),
    )
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_never_started"

    async with _runner_client(app) as client:
        assert conv_id not in app.state.superside_chat_rollover_tasks
        await asyncio.wait_for(_post_turn(client, conv_id, "first question"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)
        await _wait_until(lambda: llm_client.call_count == 1, timeout=2.0)
        _assert_trimmed_to_the_budget(harness_client, "first question")
        assert pm.released == [conv_id]

        gate.set()
        await asyncio.wait_for(app.state.superside_chat_rollover_tasks[conv_id], timeout=5.0)


@pytest.mark.asyncio
async def test_below_the_hard_limit_the_whole_record_is_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The trim only applies at the hard limit."""
    monkeypatch.setattr(
        "omnigent.runner.app._get_runner_llm_client", lambda: _GatedLLMClient(asyncio.Event())
    )
    server_client = _HardLimitServerClient(
        labels={**_hard_limit_labels(), "omnigent.last_context_window": "1000000"},
        items=_long_history_items(),
    )
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, "conv_whole", "hello"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)

    messages = [
        m for m in harness_client.posted_bodies[0]["content"] if m.get("type") == "message"
    ]
    assert len(messages) >= 60


@pytest.mark.asyncio
async def test_second_rollover_is_not_scheduled_while_one_is_in_flight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two consecutive over-threshold turns share one rollover task."""
    gate = asyncio.Event()
    llm_client = _GatedLLMClient(gate)
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)

    labels = {**_SUPERSIDE_LABELS, "omnigent.last_context_window": "1000000"}
    server_client = _ThresholdServerClient(labels=labels, items=_history_items())
    harness_client = _SequencedHarnessClient(
        [_triggering_frames(500_000), _triggering_frames(520_000)]
    )
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_two"

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "one"), timeout=5.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        first = app.state.superside_chat_rollover_tasks[conv_id]

        await asyncio.wait_for(_post_turn(client, conv_id, "two"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 2, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        assert app.state.superside_chat_rollover_tasks[conv_id] is first

        gate.set()
        await asyncio.wait_for(first, timeout=5.0)

    assert llm_client.call_count == 1
    assert len(server_client.posted_compactions) == 1


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

    # Stale by far more than the 10s idle-refresh threshold above, and longer than the
    # kept tail, so the return would summarize.
    stale = int(time.time()) - 10_000
    server_client = _ThresholdServerClient(
        labels=_hard_limit_labels(),
        items=[{**it, "created_at": stale} for it in _long_history_items()],
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


# ── cold start reads the record from the checkpoint's anchor ─────────────


class _RecordServerClient(_HardLimitServerClient):
    """The items route in memory (``type``, ``order``, ``limit``, exclusive ``after``),
    recording every request made to it."""

    def __init__(self, *, labels: dict[str, str], items: list[dict[str, Any]]) -> None:
        super().__init__(labels=labels, items=items)
        self.item_requests: list[dict[str, str]] = []

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if not url.endswith("/items"):
            return await super().get(url, **kwargs)
        params = dict(kwargs.get("params") or {})
        self.item_requests.append(params)
        order = [it["id"] for it in self._items]
        rows = [it for it in self._items if params.get("type") in (None, it["type"])]
        desc = params.get("order") == "desc"
        if params.get("after"):
            assert params["after"] in order, "stale cursor"
            at = order.index(params["after"])
            rows = [
                it
                for it in rows
                if (order.index(it["id"]) < at if desc else order.index(it["id"]) > at)
            ]
        rows = rows[::-1] if desc else rows
        limit = int(params.get("limit", "100"))
        page, more = rows[:limit], len(rows) > limit

        class _Page(NullServerClient._Response):
            def json(self) -> dict[str, Any]:
                return {"data": page, "has_more": more}

        return _Page()


def _record_item(item_id: str, role: str, text: str) -> dict[str, Any]:
    kind = "input_text" if role == "user" else "output_text"
    return {
        "id": item_id,
        "type": "message",
        "status": "completed",
        "response_id": f"r_{item_id}",
        "created_at": int(time.time()),
        "role": role,
        "content": [{"type": kind, "text": text}],
    }


def _checkpoint_item(item_id: str, *, summary: str, last_item_id: str) -> dict[str, Any]:
    pair = [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "HEADER"}]},
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": summary}],
        },
    ]
    return {
        "id": item_id,
        "type": "compaction",
        "status": "completed",
        "response_id": f"compact_{item_id}",
        "created_at": int(time.time()),
        "summary": summary,
        "last_item_id": last_item_id,
        "model": "claude-test",
        "token_count": 10,
        "compacted_messages": pair,
    }


def _texts(content: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [
        (m["role"], " ".join(b["text"] for b in m["content"] if "text" in b))
        for m in content
        if m.get("type") == "message"
    ]


async def _first_turn_content(
    server_client: _RecordServerClient, conv_id: str
) -> list[dict[str, Any]]:
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)
    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
    return harness_client.posted_bodies[0]["content"]


@pytest.mark.asyncio
async def test_cold_start_reads_the_record_from_the_anchor_only() -> None:
    old = [
        _record_item(f"old{i}", "user" if i % 2 == 0 else "assistant", f"old {i}")
        for i in range(3000)
    ]
    during = [
        _record_item("d0", "user", "asked during"),
        _record_item("d1", "assistant", "answered"),
    ]
    after = [_record_item("n0", "user", "after"), _record_item("n1", "assistant", "after answer")]
    checkpoint = _checkpoint_item("c1", summary="REAL STATE", last_item_id="old2999")
    server_client = _RecordServerClient(
        labels=_SUPERSIDE_LABELS, items=[*old, *during, checkpoint, *after]
    )

    content = await _first_turn_content(server_client, "conv_cold_anchor")

    reads = [p for p in server_client.item_requests if p.get("order") == "asc"]
    assert reads == [{"limit": "1000", "order": "asc", "after": "old2999"}]
    # Exactly what the full read yields: the checkpoint's exchange, the turn that ran
    # while it summarized, everything since, then this turn's message.
    assert _texts(content)[:-1] == [
        ("user", "HEADER"),
        ("assistant", "REAL STATE"),
        ("user", "asked during"),
        ("assistant", "answered"),
        ("user", "after"),
        ("assistant", "after answer"),
    ]
    assert "hello" in _texts(content)[-1][1]


@pytest.mark.asyncio
async def test_cold_start_without_a_checkpoint_reads_from_the_start() -> None:
    items = [_record_item("u1", "user", "question"), _record_item("a1", "assistant", "answer")]
    server_client = _RecordServerClient(labels=_SUPERSIDE_LABELS, items=items)

    content = await _first_turn_content(server_client, "conv_cold_plain")

    reads = [p for p in server_client.item_requests if p.get("order") == "asc"]
    assert reads == [{"limit": "1000", "order": "asc"}]
    assert _texts(content)[:2] == [("user", "question"), ("assistant", "answer")]


@pytest.mark.asyncio
async def test_cold_start_does_not_feed_a_placeholder_checkpoint_back_as_state() -> None:
    placeholder = "[Claude Code compaction — context was automatically compacted]"
    items = [
        _record_item("u1", "user", "old"),
        _record_item("a1", "assistant", "old answer"),
        _checkpoint_item("c1", summary="REAL STATE", last_item_id="a1"),
        _record_item("u2", "user", "work the placeholder covered"),
        _record_item("a2", "assistant", "its answer"),
        _checkpoint_item("c2", summary=placeholder, last_item_id="a2"),
    ]
    server_client = _RecordServerClient(labels=_SUPERSIDE_LABELS, items=items)

    content = await _first_turn_content(server_client, "conv_cold_placeholder")

    assert _texts(content)[:-1] == [
        ("user", "HEADER"),
        ("assistant", "REAL STATE"),
        ("user", "work the placeholder covered"),
        ("assistant", "its answer"),
    ]
    assert not any(placeholder in text for _role, text in _texts(content))


# ── /compact in Super Chat mode is Omnigent's own compaction ─────────────


def _drain_events(app: Any, conv_id: str) -> list[str]:
    queue = app.state.session_event_queues.get(conv_id)
    types: list[str] = []
    while queue is not None and not queue.empty():
        event = queue.get_nowait()
        if event and str(event.get("type", "")).startswith("response.compaction"):
            types.append(event["type"])
    return types


@pytest.mark.asyncio
async def test_compact_in_superside_chat_mode_posts_a_real_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm_client = _GatedLLMClient(asyncio.Event(), text="REAL STATE FILE")
    llm_client._gate.set()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    server_client = _RecordServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_compact"

    async with _runner_client(app) as client:
        await asyncio.wait_for(
            client.post(
                f"/v1/sessions/{conv_id}/events",
                json={
                    "type": "message",
                    "role": "user",
                    "model": "test-agent",
                    "content": [{"type": "input_text", "text": "hello"}],
                    "harness_override": "claude-sdk",
                },
            ),
            timeout=5.0,
        )
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        _drain_events(app, conv_id)

        resp = await client.post(f"/v1/sessions/{conv_id}/events", json={"type": "compact"})
        assert resp.status_code == 200, resp.text
        await _wait_until(lambda: len(server_client.posted_compactions) == 1, timeout=3.0)
        await _wait_until(lambda: pm.released == [conv_id], timeout=3.0)

    summary = server_client.posted_compactions[0]["data"]["summary"]
    assert "REAL STATE FILE" in summary
    assert "automatically compacted" not in summary
    # No literal /compact turn was sent to the SDK.
    assert len(harness_client.posted_bodies) == 1
    assert _drain_events(app, conv_id) == [
        "response.compaction.in_progress",
        "response.compaction.completed",
    ]


_STATE_TEXT = "## Working list\n- [t-launch · 2026-10-09] Spring launch budget"
_JOURNAL_REPLY = f"{_STATE_TEXT}\n<journal>\n2026-10-12 · Planned the launch\n</journal>"


class _RejectingCompactionClient(_RecordServerClient):
    """Refuses every compaction write with a 500."""

    async def post(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        response = await super().post(url, **kwargs)
        body = kwargs.get("json", {})
        if isinstance(body, dict) and body.get("type") == "compaction":

            class _Failed(NullServerClient._Response):
                status_code = 500

            return _Failed()
        return response


async def _compact_once(
    monkeypatch: pytest.MonkeyPatch, server_client: _RecordServerClient, conv_id: str
) -> _FakeProcessManager:
    llm_client = _GatedLLMClient(asyncio.Event(), text=_JOURNAL_REPLY)
    llm_client._gate.set()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    app, pm = _build_app(_SequencedHarnessClient([_plain_frames()]), server_client)
    async with _runner_client(app) as client:
        await asyncio.wait_for(
            client.post(
                f"/v1/sessions/{conv_id}/events",
                json={
                    "type": "message",
                    "role": "user",
                    "model": "test-agent",
                    "content": [{"type": "input_text", "text": "hello"}],
                    "harness_override": "claude-sdk",
                },
            ),
            timeout=5.0,
        )
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
        resp = await client.post(f"/v1/sessions/{conv_id}/events", json={"type": "compact"})
        assert resp.status_code == 200, resp.text
        await _wait_until(lambda: len(server_client.posted_compactions) == 1, timeout=3.0)
        await asyncio.sleep(0.2)
    return pm


@pytest.mark.asyncio
async def test_a_stored_checkpoint_writes_the_journal_and_state_files(
    monkeypatch: pytest.MonkeyPatch, _isolated_knowledge_workspace: Path
) -> None:
    server_client = _RecordServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())

    await _compact_once(monkeypatch, server_client, "conv_journal")

    journal = (_isolated_knowledge_workspace / "memory" / "journal" / "2026-10-12.md").read_text()
    assert "- 2026-10-12 · Planned the launch · main <!-- conv_journal -->" in journal
    state = (_isolated_knowledge_workspace / "memory" / "STATE.md").read_text()
    assert "Spring launch budget" in state
    assert "Context checkpoint" not in state


@pytest.mark.asyncio
async def test_a_failed_checkpoint_post_writes_no_memory_files(
    monkeypatch: pytest.MonkeyPatch, _isolated_knowledge_workspace: Path
) -> None:
    server_client = _RejectingCompactionClient(labels=_SUPERSIDE_LABELS, items=_history_items())

    await _compact_once(monkeypatch, server_client, "conv_journal_failed")

    assert list((_isolated_knowledge_workspace / "memory").rglob("*.md")) == []


@pytest.mark.asyncio
async def test_a_turn_in_a_computer_with_no_memory_folder_rebuilds_it(
    monkeypatch: pytest.MonkeyPatch, _isolated_knowledge_workspace: Path
) -> None:
    (_isolated_knowledge_workspace / "memory").rmdir()
    items = [
        *_history_items(),
        {
            **_checkpoint_item(
                "c1", summary=f"{checkpoint_header('size')}\n\n{_STATE_TEXT}", last_item_id="a1"
            ),
            "journal_lines": ["2026-10-11 · Asked for a budget"],
        },
    ]
    server_client = _RecordServerClient(labels=_SUPERSIDE_LABELS, items=items)
    app, _pm = _build_app(_SequencedHarnessClient([_plain_frames()]), server_client)

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, "conv_lost_volume", "hello"), timeout=5.0)
        memory = _isolated_knowledge_workspace / "memory"
        await _wait_until(lambda: (memory / "STATE.md").exists(), timeout=3.0)

    journal = (memory / "journal" / "2026-10-11.md").read_text()
    assert "Asked for a budget · main <!-- conv_lost_volume -->" in journal


# ── return after idle: a cold start, not a rewrite ───────────────────────

_THREE_DAYS = 3 * 86_400
_GAP_LINE = "It has been 3 days since the last message."


def _last_user_text(body: dict[str, Any]) -> str:
    """The text of the last user message the harness was sent."""
    return [text for role, text in _texts(body["content"]) if role == "user"][-1]


@pytest.mark.asyncio
async def test_return_after_idle_makes_no_summarizer_call_and_names_the_gap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS", "10")
    llm_client = _GatedLLMClient(asyncio.Event())
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    server_client = _HardLimitServerClient(
        labels=_SUPERSIDE_LABELS, items=_idle_history_items(_THREE_DAYS)
    )
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    conv_id = "conv_return_small"

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

    assert llm_client.call_count == 0
    assert server_client.posted_compactions == []
    assert pm.released == [conv_id]  # the warm client was dropped: a cold start
    text = _last_user_text(harness_client.posted_bodies[0])
    assert _GAP_LINE in text
    # The line is not persisted: it rides this turn's message only.
    assert _GAP_LINE not in str(server_client._items)


@pytest.mark.asyncio
async def test_a_turn_that_is_not_a_return_has_no_gap_line() -> None:
    server_client = _HardLimitServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, "conv_no_gap", "hello"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)

    assert "since the last message" not in _last_user_text(harness_client.posted_bodies[0])


@pytest.mark.asyncio
async def test_return_after_idle_with_more_than_the_tail_budget_rolls_over(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.context.rollover import checkpoint_header

    monkeypatch.setenv("OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS", "10")
    llm_client = _GatedLLMClient(asyncio.Event(), text="STATE")
    llm_client._gate.set()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    stale = int(time.time()) - _THREE_DAYS
    items = [{**it, "created_at": stale} for it in _long_history_items()]
    server_client = _HardLimitServerClient(labels=_hard_limit_labels(), items=items)
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, _pm = _build_app(harness_client, server_client)
    conv_id = "conv_return_large"

    async with _runner_client(app) as client:
        await asyncio.wait_for(_post_turn(client, conv_id, "hello"), timeout=5.0)
        await _wait_until(lambda: len(harness_client.posted_bodies) == 1, timeout=2.0)
        await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)

    assert llm_client.call_count == 1
    [posted] = server_client.posted_compactions
    assert posted["data"]["summary"].startswith(checkpoint_header("return"))
    assert _GAP_LINE in _last_user_text(harness_client.posted_bodies[0])


# ── prefix delta: the profile and Projects go in full only when needed ───

_PROFILE = (
    "[Standing memory about the user, provided by the system, not a message from the "
    "user]\n\nPreferences:\n- Prefers figures in CAD\n\n[End of standing memory]"
)
_PROFILE_LINE = "Standing memory unchanged since the last message."


class _ProfileServerClient(_HardLimitServerClient):
    """Also serves the Memory Profile, which a test can change between turns."""

    def __init__(self, *, labels: dict[str, str], items: list[dict[str, Any]]) -> None:
        super().__init__(labels=labels, items=items)
        self.profile = _PROFILE

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if url.endswith("/memory/profile"):
            profile = self.profile

            class _ProfileResponse(NullServerClient._Response):
                def json(self) -> dict[str, Any]:
                    return {"profile": profile}

            return _ProfileResponse()
        return await super().get(url, **kwargs)


async def _turn(
    app: Any,
    client: Any,
    harness_client: _SequencedHarnessClient,
    conv_id: str,
    *,
    tools: list[dict[str, Any]] | None = None,
) -> str:
    """Run one turn to completion and return the text of the message the harness got."""
    sent = len(harness_client.posted_bodies)
    body: dict[str, Any] = {
        "type": "message",
        "role": "user",
        "model": "test-agent",
        "content": [{"type": "input_text", "text": f"question {sent}"}],
        "harness": "claude-sdk",
        "harness_override": "claude-sdk",
    }
    if tools is not None:
        body["tools"] = tools
    await asyncio.wait_for(client.post(f"/v1/sessions/{conv_id}/events", json=body), timeout=5.0)
    await _wait_until(lambda: len(harness_client.posted_bodies) == sent + 1, timeout=2.0)
    await _wait_until(lambda: conv_id not in app.state.active_turns, timeout=2.0)
    return _last_user_text(harness_client.posted_bodies[-1])


def _delta_app() -> tuple[Any, _FakeProcessManager, _SequencedHarnessClient, _ProfileServerClient]:
    server_client = _ProfileServerClient(labels=_SUPERSIDE_LABELS, items=_history_items())
    harness_client = _SequencedHarnessClient([_plain_frames()])
    app, pm = _build_app(harness_client, server_client)
    return app, pm, harness_client, server_client


@pytest.mark.asyncio
async def test_a_warm_client_gets_the_profile_once_then_one_line() -> None:
    app, _pm, harness_client, server_client = _delta_app()
    conv_id = "conv_delta_warm"

    async with _runner_client(app) as client:
        first = await _turn(app, client, harness_client, conv_id)
        second = await _turn(app, client, harness_client, conv_id)
        third = await _turn(app, client, harness_client, conv_id)
        server_client.profile = _PROFILE.replace("CAD", "EUR")
        changed = await _turn(app, client, harness_client, conv_id)
        after_change = await _turn(app, client, harness_client, conv_id)

    assert _PROFILE in first and _PROFILE_LINE not in first
    for text in (second, third, after_change):
        assert _PROFILE_LINE in text and "Prefers figures" not in text
    assert "Prefers figures in EUR" in changed and _PROFILE_LINE not in changed


@pytest.mark.asyncio
async def test_warm_turns_with_an_unchanged_profile_add_under_300_prefix_tokens() -> None:
    from omnigent.context.rollover import count_tokens
    from omnigent.models.model_fallbacks import ROLLOVER_TOKEN_COUNT_MODEL

    app, _pm, harness_client, _server = _delta_app()
    conv_id = "conv_delta_budget"
    prefix_tokens: list[int] = []

    async with _runner_client(app) as client:
        for _ in range(50):
            text = await _turn(app, client, harness_client, conv_id)
            prefix = text.removesuffix(f"question {len(harness_client.posted_bodies) - 1}")
            prefix_tokens.append(
                count_tokens(
                    [{"type": "message", "role": "user", "content": prefix}],
                    ROLLOVER_TOKEN_COUNT_MODEL,
                )
            )

    assert prefix_tokens[0] > 0
    assert max(prefix_tokens[1:]) < 300


async def _drop_via_compact(app: Any, client: Any, conv_id: str, pm: _FakeProcessManager) -> None:
    resp = await client.post(f"/v1/sessions/{conv_id}/events", json={"type": "compact"})
    assert resp.status_code == 200, resp.text
    await _wait_until(lambda: pm.released == [conv_id], timeout=3.0)
    await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_after_a_warm_client_drop_the_next_turn_carries_the_profile_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm_client = _GatedLLMClient(asyncio.Event(), text="STATE")
    llm_client._gate.set()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    app, pm, harness_client, _server = _delta_app()
    conv_id = "conv_delta_drops"

    async with _runner_client(app) as client:
        await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)

        # A rollover (here a manual /compact) drops the client.
        await _drop_via_compact(app, client, conv_id, pm)
        assert _PROFILE in await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)

        # The harness process was released or restarted behind the runner's back.
        await pm.release(conv_id)
        assert _PROFILE in await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)

        # A turn that failed leaves nothing remembered: the client may be gone.
        failed = _SequencedHarnessClient([_failed_frames(), _plain_frames()])
        harness_client._sequences = failed._sequences
        harness_client.call_count = 0
        await _turn(app, client, harness_client, conv_id)
        assert _PROFILE in await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)


def _failed_frames() -> list[str]:
    return [
        _sse({"type": "response.created", "response": {"id": "resp_failed"}}),
        _sse({"type": "response.failed", "error": {"message": "boom", "type": "server_error"}}),
    ]


@pytest.mark.asyncio
async def test_a_return_from_idle_and_the_hard_limit_drop_the_remembered_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS", "10")
    llm_client = _GatedLLMClient(asyncio.Event(), text="STATE")
    llm_client._gate.set()
    monkeypatch.setattr("omnigent.runner.app._get_runner_llm_client", lambda: llm_client)
    app, _pm, harness_client, server_client = _delta_app()
    conv_id = "conv_delta_idle"

    async with _runner_client(app) as client:
        await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)

        server_client._items[:] = _idle_history_items(_THREE_DAYS)
        back = await _turn(app, client, harness_client, conv_id)
        assert _PROFILE in back and _GAP_LINE in back
        server_client._items[:] = _history_items()
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)

        # Past the hard limit the turn cold-starts from the record.
        server_client._labels = _hard_limit_labels()
        harness_client._sequences = [_triggering_frames(500_000), _plain_frames()]
        harness_client.call_count = 0
        await _turn(app, client, harness_client, conv_id)
        assert _PROFILE in await _turn(app, client, harness_client, conv_id)


@pytest.mark.asyncio
async def test_a_changed_system_prompt_makes_the_next_turn_carry_the_profile_again() -> None:
    """The executor rebuilds its client when the prompt it builds changes (a new tool set
    here), and replays the persisted record, which holds no prefix blocks."""
    app, _pm, harness_client, _server = _delta_app()
    conv_id = "conv_delta_prompt"
    tool = {
        "type": "function",
        "function": {"name": "client_tool", "parameters": {"type": "object"}},
    }

    async with _runner_client(app) as client:
        await _turn(app, client, harness_client, conv_id)
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id)
        assert _PROFILE in await _turn(app, client, harness_client, conv_id, tools=[tool])
        assert _PROFILE_LINE in await _turn(app, client, harness_client, conv_id, tools=[tool])
