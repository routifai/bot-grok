"""Tests for parent-bound (Helper) scheduled fires: binding, gating, retry."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from omnigent.context.labels import ADHOC_HELPER_LABEL_KEY, SCHEDULED_HELPER_LABEL_KEY
from omnigent.entities import OwnerPreferences, ScheduledTaskRun
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL
from omnigent.server.scheduled import fire as fire_mod
from omnigent.server.scheduled import helper_fire
from omnigent.server.scheduled.fire import build_on_fire
from omnigent.server.scheduled.helper_fire import _quiet_window_end, build_retry
from omnigent.stores.conversation_store import NameAlreadyExistsError
from tests.server.scheduled.test_fire import (
    FakeConversationStore,
    FakePermissionStore,
    FakeScheduledTaskStore,
    _deps,
    _drain,
    _task,
)


@dataclass
class _Parent:
    id: str = "conv_parent"
    agent_id: str = "ag_1"
    runner_id: str | None = "runner_1"
    model_override: str | None = None
    inference_snapshot: Any = None
    labels: dict[str, str] = field(
        default_factory=lambda: {"omnigent.context.mode": "superside-chat", "other": "x"}
    )


class _ParentConversationStore(FakeConversationStore):
    def __init__(self, parent: _Parent | None) -> None:
        super().__init__()
        self.parent = parent
        self.appended: dict[str, list[Any]] = {}
        self.live_status: dict[str, str] = {}

    def get_conversation(self, conversation_id: str) -> Any:
        return self.parent if conversation_id == "conv_parent" else None

    def append(self, conversation_id: str, items: list[Any]) -> list[Any]:
        self.appended.setdefault(conversation_id, []).extend(items)
        return []

    def set_session_live_status(self, conversation_id: str, status: str) -> None:
        self.live_status[conversation_id] = status


class _Store(FakeScheduledTaskStore):
    def __init__(self, rows: dict[str, Any], prefs: OwnerPreferences | None = None) -> None:
        super().__init__(rows=rows)
        self.prefs = prefs
        self.running: list[ScheduledTaskRun] = []

    def get_owner_preferences(self, user_id: str) -> OwnerPreferences | None:
        return self.prefs

    def list(self, **_: Any) -> list[Any]:
        return list(self._rows.values())

    def list_running_runs_for_tasks(self, ids: list[str]) -> list[ScheduledTaskRun]:
        return [r for r in self.running if r.scheduled_task_id in ids]


def _bound_task(**overrides: Any) -> Any:
    return _task(
        **{
            "parent_session_id": "conv_parent",
            "agent_type": "researcher",
            "host_id": None,
            "workspace": None,
            **overrides,
        }
    )


@pytest.fixture(autouse=True)
def _clean_state() -> Any:
    yield
    for handle in fire_mod._REFIRES.values():
        handle.cancel()
    fire_mod._REFIRES.clear()
    fire_mod._OWNER_LAUNCHING.clear()


async def _fire(store: _Store, conv_store: Any, launch: Any, **deps: Any) -> None:
    on_fire = build_on_fire(
        _deps(store, conversation_store=conv_store, **deps), launch_dispatch=launch
    )
    await on_fire(0, "task_1")
    await _drain()


async def _ok_launch(conv: Any, task: Any) -> None:
    return None


async def _boom(conv: Any, task: Any) -> None:
    raise RuntimeError("runner down")


async def test_fire_creates_helper_child_of_parent() -> None:
    perm = FakePermissionStore()
    conv_store = _ParentConversationStore(_Parent())
    store = _Store({"task_1": _bound_task(model_override="m1")})
    launched: list[Any] = []

    async def launch(conv: Any, task: Any) -> None:
        launched.append(conv)

    await _fire(store, conv_store, launch, permission_store=perm)

    created = conv_store.created[0]
    assert created["kind"] == "sub_agent"
    assert created["parent_conversation_id"] == "conv_parent"
    # A stored retired Type (researcher) runs as the general worker.
    assert created["sub_agent_name"] == "worker"
    assert created["agent_id"] == "ag_1"
    assert created["runner_id"] == "runner_1"
    assert created["model_override"] == "m1"
    labels = created["labels"]
    assert labels["omnigent.context.mode"] == "superside-chat"
    assert "other" not in labels
    assert labels["omnigent.subagent.scheduled_task_id"] == "task_1"
    assert labels["omnigent.subagent.dispatch_id"].startswith("subagent_")
    assert len(launched) == 1
    assert store.runs[0]["status"] == "running"
    assert store.runs[0]["conversation_id"] == "conv_1"
    assert store.runs[0]["attempt"] == 1
    # Same as a sys_session_create child: the task owner owns the Helper, so
    # owner-scoped routes (memory/profile) resolve it.
    assert (RESERVED_USER_LOCAL, "conv_1", LEVEL_OWNER) in perm.grants
    # Titled with the task name, not an opaque id ("Researcher: nightly").
    assert created["title"] == "researcher:nightly"


async def test_helper_owner_grant_goes_to_task_owner() -> None:
    perm = FakePermissionStore()
    conv_store = _ParentConversationStore(_Parent())
    store = _Store({"task_1": _bound_task(user_id="alice")})
    await _fire(store, conv_store, _ok_launch, permission_store=perm)
    assert ("alice", "conv_1", LEVEL_OWNER) in perm.grants


async def test_helper_title_collision_falls_back_to_timestamped_title() -> None:
    class _Dup(_ParentConversationStore):
        def create_conversation(self, **kwargs: Any) -> Any:
            if kwargs["title"] == "researcher:nightly":
                raise NameAlreadyExistsError("dup")
            return super().create_conversation(**kwargs)

    conv_store = _Dup(_Parent())
    store = _Store({"task_1": _bound_task()})
    await _fire(store, conv_store, _ok_launch)
    title = conv_store.created[0]["title"]
    assert title.startswith("researcher:nightly (")
    assert store.runs[0]["status"] == "running"


async def test_parent_runner_dispatch_starts_relay_before_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a relay the idle edge never reaches the server and the run stays running."""
    from omnigent.server.routes import sessions as sessions_mod

    calls: list[str] = []

    async def _client(*_a: Any, **_k: Any) -> object:
        return object()

    async def _init(*_a: Any, **_k: Any) -> None:
        calls.append("init")

    async def _relay(session_id: str, runner_id: str | None, *_a: Any, **_k: Any) -> None:
        calls.append(f"relay:{session_id}:{runner_id}")

    async def _send(*_a: Any, **_k: Any) -> None:
        calls.append("send")

    monkeypatch.setattr(sessions_mod, "_wait_for_runner_client", _client)
    monkeypatch.setattr(sessions_mod, "_ensure_runner_session_initialized", _init)
    monkeypatch.setattr(sessions_mod, "_ensure_runner_relay_ready", _relay)
    monkeypatch.setattr(sessions_mod, "_dispatch_session_event_to_runner", _send)

    conv_store = _ParentConversationStore(_Parent())
    dispatch = fire_mod._make_parent_runner_dispatch(
        _deps(_Store({}), conversation_store=conv_store)
    )

    class _Conv:
        id = "conv_h"
        runner_id = "runner_1"

    await dispatch(_Conv(), _bound_task())
    assert calls == ["init", "relay:conv_h:runner_1", "send"]


async def test_missing_parent_fails_without_retry() -> None:
    store = _Store({"task_1": _bound_task()})
    await _fire(store, _ParentConversationStore(None), _ok_launch)
    assert store.runs[0]["status"] == "failed"
    assert store.runs[0]["error_code"] == "parent_not_found"
    assert not fire_mod._REFIRES


async def test_proactivity_off_skips() -> None:
    store = _Store({"task_1": _bound_task()}, OwnerPreferences("local", proactivity="off"))
    conv_store = _ParentConversationStore(_Parent())
    await _fire(store, conv_store, _ok_launch)
    assert store.runs[0]["status"] == "skipped"
    assert store.runs[0]["error_code"] == "proactivity_off"
    assert conv_store.created == []


async def test_gating_does_not_apply_to_plain_tasks() -> None:
    store = _Store({"task_1": _task()}, OwnerPreferences("local", proactivity="off"))
    await _fire(store, _ParentConversationStore(_Parent()), _ok_launch)
    assert store.runs[0]["status"] == "running"


async def test_quiet_hours_defers_to_window_end() -> None:
    hour = datetime.fromtimestamp(time.time(), ZoneInfo("UTC")).hour
    prefs = OwnerPreferences(
        "local",
        quiet_start=f"{(hour - 1) % 24:02d}:00",
        quiet_end=f"{(hour + 1) % 24:02d}:00",
        timezone="UTC",
    )
    store = _Store({"task_1": _bound_task()}, prefs)
    conv_store = _ParentConversationStore(_Parent())
    await _fire(store, conv_store, _ok_launch)
    assert store.runs[0]["status"] == "skipped"
    assert store.runs[0]["error_code"] == "quiet_hours_deferred"
    assert (0, "task_1") in fire_mod._REFIRES
    assert conv_store.created == []


def test_quiet_window_end_crossing_midnight() -> None:
    prefs = OwnerPreferences(
        "u", quiet_start="22:00", quiet_end="07:00", timezone="America/Toronto"
    )
    tz = ZoneInfo("America/Toronto")
    late = datetime(2026, 10, 3, 23, 30, tzinfo=tz).timestamp()
    early = datetime(2026, 10, 4, 6, 0, tzinfo=tz).timestamp()
    midday = datetime(2026, 10, 4, 12, 0, tzinfo=tz).timestamp()
    expected = datetime(2026, 10, 4, 7, 0, tzinfo=tz).timestamp()
    assert _quiet_window_end(prefs, late) == expected
    assert _quiet_window_end(prefs, early) == expected
    assert _quiet_window_end(prefs, midday) is None
    assert _quiet_window_end(OwnerPreferences("u"), late) is None


async def test_owner_busy_defers_then_skips() -> None:
    store = _Store({"task_1": _bound_task(), "task_2": _bound_task(id="task_2")})
    now = int(time.time())
    store.running = [ScheduledTaskRun("r1", "task_2", "running", now, fired_at=now)]
    conv_store = _ParentConversationStore(_Parent())
    await _fire(store, conv_store, _ok_launch)
    assert store.runs[0]["error_code"] == "owner_busy_deferred"
    assert (0, "task_1") in fire_mod._REFIRES
    assert conv_store.created == []

    # Once the deferral budget is spent the fire is skipped outright.
    fire_mod._REFIRES.pop((0, "task_1")).cancel()
    deps = _deps(store, conversation_store=conv_store)
    await fire_mod._run_parent_bound_fire(
        deps,
        _bound_task(),
        fire_mod._build_fire_dispatch(deps, _ok_launch),
        now,
        attempt=1,
        deferrals=fire_mod._MAX_OWNER_BUSY_DEFERRALS,
    )
    assert store.runs[-1]["error_code"] == "owner_busy"
    assert not fire_mod._REFIRES


async def test_failed_launch_schedules_one_retry() -> None:
    store = _Store({"task_1": _bound_task()})
    conv_store = _ParentConversationStore(_Parent())
    await _fire(store, conv_store, _boom)
    run = store.runs[0]
    assert run["status"] == "failed" and run["error_code"] == "launch_failed"
    assert "retry scheduled" in run["error"]
    assert (0, "task_1") in fire_mod._REFIRES

    # The retry (attempt 2) that fails again is not retried.
    fire_mod._REFIRES.pop((0, "task_1")).cancel()
    deps = _deps(store, conversation_store=conv_store)
    await fire_mod._run_parent_bound_fire(
        deps,
        _bound_task(),
        fire_mod._build_fire_dispatch(deps, _boom),
        int(time.time()),
        attempt=2,
        deferrals=0,
    )
    assert store.runs[-1]["attempt"] == 2
    assert "retry" not in store.runs[-1]["error"]
    assert not fire_mod._REFIRES


async def test_low_proactivity_does_not_retry() -> None:
    store = _Store({"task_1": _bound_task()}, OwnerPreferences("local", proactivity="low"))
    await _fire(store, _ParentConversationStore(_Parent()), _boom)
    assert store.runs[0]["status"] == "failed"
    assert not fire_mod._REFIRES


async def test_build_retry_arms_once_and_stops_after_second_attempt() -> None:
    store = _Store({"task_1": _bound_task()})
    retry = build_retry(_deps(store), launch_dispatch=_ok_launch)
    assert retry(0, "task_1", 1) is True
    assert retry(0, "task_1", 1) is False  # already pending
    fire_mod._REFIRES.pop((0, "task_1")).cancel()
    assert retry(0, "task_1", 2) is False
    await asyncio.sleep(0)


async def test_adhoc_helper_runs_now_without_waking_the_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    perm = FakePermissionStore()
    conv_store = _ParentConversationStore(_Parent())
    sent: dict[str, Any] = {}

    def fake_dispatch(deps: Any, *, event: Any = None) -> Any:
        async def dispatch(conv: Any, task: Any) -> None:
            sent["event"], sent["conv"] = event, conv

        return dispatch

    monkeypatch.setattr(fire_mod, "_make_parent_runner_dispatch", fake_dispatch)
    deps = _deps(_Store({}), conversation_store=conv_store, permission_store=perm)
    content = [{"type": "input_text", "text": "brief"}, {"type": "input_image", "image_url": "u"}]
    conv_id = await helper_fire.start_adhoc_helper(
        deps,
        parent_session_id="conv_parent",
        agent_type="teacher",
        name="Learn: search",
        user_id=None,
        content=content,
    )
    created = conv_store.created[0]
    assert created["sub_agent_name"] == "teacher" and created["kind"] == "sub_agent"
    assert created["parent_conversation_id"] == "conv_parent"
    assert SCHEDULED_HELPER_LABEL_KEY not in created["labels"]
    # no wake, but it may read the parent chat through session_history
    assert ADHOC_HELPER_LABEL_KEY in created["labels"]
    assert sent["event"].data["content"] == content
    assert conv_id == sent["conv"].id
    assert perm.grants and perm.grants[0][2] == LEVEL_OWNER


# ── The Helper's harness and model follow the bundle ────────────────────────

_BUNDLES = Path(__file__).resolve().parents[5] / "infra/omnigent/agents"


class _BundleAgentStore:
    def get(self, agent_id: str) -> Any:
        return SimpleNamespace(id=agent_id, bundle_location="bundle")


class _BundleCache:
    """Loads the real rendered bundle, like the server's agent cache."""

    def __init__(self, bundle: str) -> None:
        self._bundle = bundle

    def load(self, agent_id: str, bundle_location: str) -> Any:
        from omnigent.spec import parse

        return SimpleNamespace(spec=parse(_BUNDLES / self._bundle))


async def _scheduled_model(
    bundle: str,
    agent_type: str,
    parent_model: str | None,
    monkeypatch: pytest.MonkeyPatch,
    env: dict[str, str],
) -> str | None:
    monkeypatch.setenv("TAVILY_API_KEY", "x")
    monkeypatch.setenv("NOVA_CLAUDE_MODEL", "muse-model")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    conv_store = _ParentConversationStore(_Parent(model_override=parent_model))
    store = _Store({"task_1": _bound_task(agent_type=agent_type)})
    await _fire(
        store,
        conv_store,
        _ok_launch,
        agent_store=_BundleAgentStore(),
        agent_cache=_BundleCache(bundle),
    )
    assert conv_store.created[0]["sub_agent_name"] == agent_type
    return conv_store.created[0]["model_override"]


_GLOBAL_CLAUDE_IDS = {
    "OMNIGENT_HELPER_MODEL_FAST": "claude-haiku-4-5",
    "OMNIGENT_HELPER_MODEL_STRONG": "claude-sonnet-4-6",
}


@pytest.mark.parametrize("agent_type", ["worker", "goal", "teacher"])
async def test_scheduled_helper_on_pi_bundle_never_gets_a_global_claude_id(
    agent_type: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    model = await _scheduled_model(
        "nova-pi", agent_type, "openai/gpt-5.6-luna", monkeypatch, _GLOBAL_CLAUDE_IDS
    )
    assert model == "openai/gpt-5.6-luna"


async def test_scheduled_helper_on_pi_bundle_uses_the_pi_fast_mapping(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env = {**_GLOBAL_CLAUDE_IDS, "OMNIGENT_HELPER_MODEL_FAST_PI": "openai/gpt-5.6-mini"}
    model = await _scheduled_model("nova-pi", "goal", "openai/gpt-5.6-luna", monkeypatch, env)
    assert model == "openai/gpt-5.6-mini"


async def test_scheduled_helper_on_claude_bundle_keeps_the_global_fast_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = await _scheduled_model("nova-claude", "worker", None, monkeypatch, _GLOBAL_CLAUDE_IDS)
    assert model == "claude-haiku-4-5"


def _wake_deps(store: Any, conv_store: Any) -> Any:
    return _deps(store, conversation_store=conv_store, app_state=SimpleNamespace())


async def test_scheduled_fire_wakes_the_parent_computer_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A sleeping Computer is launched through the message path, then the Helper is dispatched."""
    from omnigent.server.routes._sessions import orchestration

    order: list[str] = []

    async def _ensure(**kwargs: Any) -> Any:
        order.append(f"wake:{kwargs['session_id']}")
        return object(), kwargs["conv"]

    async def launch(conv: Any, task: Any) -> None:
        order.append("dispatch")

    monkeypatch.setattr(orchestration, "ensure_runner_connected", _ensure)
    store = _Store({"task_1": _bound_task()})
    conv_store = _ParentConversationStore(_Parent())
    on_fire = build_on_fire(_wake_deps(store, conv_store), launch_dispatch=launch)
    await on_fire(0, "task_1")
    await _drain()

    assert order == ["wake:conv_parent", "dispatch"]
    assert store.runs[0]["status"] == "running"
    assert conv_store.appended == {}


async def test_failed_wake_records_launch_failed_and_retries_quietly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.errors import ErrorCode, OmnigentError
    from omnigent.server.routes._sessions import orchestration

    async def _ensure(**_: Any) -> Any:
        raise OmnigentError("sandbox quota", code=ErrorCode.RUNNER_UNAVAILABLE)

    dispatched: list[Any] = []

    async def launch(conv: Any, task: Any) -> None:
        dispatched.append(conv)

    monkeypatch.setattr(orchestration, "ensure_runner_connected", _ensure)
    store = _Store({"task_1": _bound_task()})
    conv_store = _ParentConversationStore(_Parent())
    await build_on_fire(_wake_deps(store, conv_store), launch_dispatch=launch)(0, "task_1")
    await _drain()

    run = store.runs[0]
    assert run["status"] == "failed" and run["error_code"] == "launch_failed"
    assert "your Computer didn't start: sandbox quota" in run["error"]
    assert "retry scheduled" in run["error"]
    assert (0, "task_1") in fire_mod._REFIRES
    assert dispatched == [] and conv_store.created == []
    assert conv_store.appended == {}  # the person is told only once the retries are spent


async def test_final_failure_posts_a_note_and_shows_as_a_failed_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.server.routes._sessions import orchestration

    async def _ensure(**_: Any) -> Any:
        return None, None

    monkeypatch.setattr(orchestration, "ensure_runner_connected", _ensure)
    store = _Store({"task_1": _bound_task(name="8am market report")})
    conv_store = _ParentConversationStore(_Parent())
    deps = _wake_deps(store, conv_store)
    await fire_mod._run_parent_bound_fire(
        deps,
        _bound_task(name="8am market report"),
        fire_mod._build_fire_dispatch(deps, _ok_launch),
        int(time.time()),
        attempt=2,
        deferrals=0,
    )

    run = store.runs[-1]
    assert run["status"] == "failed" and run["error_code"] == "launch_failed"
    assert not fire_mod._REFIRES
    # The run has a Helper session, marked failed with the reason, so Activity reads it as failed.
    assert run["conversation_id"] == "conv_1"
    assert conv_store.live_status == {"conv_1": "failed"}
    helper_error = conv_store.appended["conv_1"][0].data
    assert helper_error.message == "Your Computer didn't start."
    # The parent Conversation gets one calm note.
    note = conv_store.appended["conv_parent"][0].data
    assert note.level == "info"
    assert note.message.startswith(
        "Your 8am market report couldn't run: your Computer didn't start."
    )
    assert "next scheduled time" in note.message


async def test_dispatch_failure_marks_its_helper_failed() -> None:
    store = _Store({"task_1": _bound_task()})
    conv_store = _ParentConversationStore(_Parent())
    await _fire(store, conv_store, _boom)
    assert conv_store.live_status == {"conv_1": "failed"}
    assert store.runs[0]["conversation_id"] == "conv_1"
    assert "conv_parent" not in conv_store.appended  # a retry is pending
