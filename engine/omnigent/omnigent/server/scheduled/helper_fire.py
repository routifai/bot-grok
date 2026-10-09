"""The parent-bound (Helper) half of the scheduled fire path.

A parent-bound task fires as a Helper session under its Super Chat: it is gated on the owner's
proactivity and quiet hours, deferred while another proactive run is in flight, retried once
after a failure, and launched on the parent's own runner. The shared state and the plumbing
common to every fire (``FireDeps``, run records, grants, the overlap guards) stay in
:mod:`omnigent.server.scheduled.fire`, which imports this module for its own use;
this module reads them through ``fire`` at call time so there is a single owner of that state.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from datetime import datetime, timedelta
from datetime import time as dtime
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.context.labels import (
    ADHOC_HELPER_LABEL_KEY,
    SCHEDULED_HELPER_LABEL_KEY,
    SUBAGENT_DISPATCH_ID_LABEL_KEY,
    inheritable_context_labels,
)
from omnigent.entities import Conversation, OwnerPreferences, ScheduledTask
from omnigent.errors import OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.server.scheduled.rrule import RRuleValidationError, get_next_fire_time
from omnigent.server.scheduled.run_reconciler import force_fail_stale_runs
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store import NameAlreadyExistsError
from omnigent.superchat.activity.titles import fire_title_candidates
from omnigent.superchat.subagents import resolve_scheduled_helper, scheduled_helper_type

# The same logger as ``fire`` (shared name, so existing log filters keep matching).
_logger = logging.getLogger("omnigent.server.scheduled.fire")

if TYPE_CHECKING:
    from omnigent.server.scheduled.fire import FireDeps, LaunchDispatch, _FireDispatch


def build_retry(
    deps: FireDeps,
    *,
    launch_dispatch: LaunchDispatch | None = None,
) -> Callable[[int, str, int], bool]:
    """Build the trigger that schedules the single retry of a failed fire.

    Used by the run reconciler when it force-fails a stale parent-bound run.

    :returns: ``retry(workspace_id, scheduled_task_id, failed_attempt) -> bool``;
        ``True`` when a retry was scheduled (only after a first attempt, and only
        when the owner has not set proactivity to ``low``).
    """
    fire_dispatch = fire._build_fire_dispatch(deps, launch_dispatch)

    def retry(workspace_id: int, scheduled_task_id: str, failed_attempt: int) -> bool:
        if failed_attempt >= fire._MAX_ATTEMPTS:
            return False
        return _schedule_refire(
            deps,
            workspace_id,
            scheduled_task_id,
            fire_dispatch,
            delay_s=fire._RETRY_BACKOFF_S,
            attempt=failed_attempt + 1,
            deferrals=0,
        )

    return retry


def _quiet_window_end(prefs: OwnerPreferences, now: float) -> float | None:
    """Epoch seconds the owner's quiet window ends, or ``None`` when ``now`` is outside it.

    The window is local ``quiet_start``-``quiet_end`` in ``prefs.timezone`` and may
    cross midnight (e.g. 22:00-07:00). Equal bounds mean no window.
    """
    if prefs.quiet_start is None or prefs.quiet_end is None:
        return None
    try:
        tz = ZoneInfo(prefs.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    start = dtime.fromisoformat(prefs.quiet_start)
    end = dtime.fromisoformat(prefs.quiet_end)
    if start == end:
        return None
    local = datetime.fromtimestamp(now, tz)
    t = local.time()
    if start < end:
        inside, end_date = start <= t < end, local.date()
    else:
        inside = t >= start or t < end
        end_date = local.date() if t < end else local.date() + timedelta(days=1)
    if not inside:
        return None
    return datetime.combine(end_date, end, tzinfo=tz).timestamp()


def _schedule_refire(
    deps: FireDeps,
    workspace_id: int,
    task_id: str,
    fire_dispatch: _FireDispatch,
    *,
    delay_s: float,
    attempt: int,
    deferrals: int,
) -> bool:
    """Arm a one-off re-fire of a task (in-process; lost on server restart).

    At most one is pending per task: a second request while one is armed is
    dropped and reported ``False``.
    """
    key = (workspace_id, task_id)
    if key in fire._REFIRES:
        return False
    loop = asyncio.get_running_loop()

    def _go() -> None:
        fire._REFIRES.pop(key, None)
        task = loop.create_task(
            fire._trigger_fire(
                deps,
                workspace_id,
                task_id,
                fire_dispatch,
                require_active=True,
                attempt=attempt,
                deferrals=deferrals,
            ),
            name=f"scheduled-refire-{task_id}",
        )
        fire._PENDING_FIRES.add(task)
        task.add_done_callback(fire._PENDING_FIRES.discard)

    fire._REFIRES[key] = loop.call_later(max(delay_s, 1.0), _go)
    return True


async def _owner_has_proactive_run_in_flight(deps: FireDeps, task: ScheduledTask) -> bool:
    """Whether any parent-bound task of this owner has a run still ``running``."""
    owned = await asyncio.to_thread(deps.scheduled_task_store.list, owner_user_id=task.user_id)
    ids = [t.id for t in owned if t.user_id == task.user_id and t.parent_session_id is not None]
    running = await asyncio.to_thread(deps.scheduled_task_store.list_running_runs_for_tasks, ids)
    live = await asyncio.to_thread(force_fail_stale_runs, deps.scheduled_task_store, running)
    return any(r.status == "running" for r in live)


async def _run_parent_bound_fire(
    deps: FireDeps,
    task: ScheduledTask,
    fire_dispatch: _FireDispatch,
    scheduled_at: int,
    *,
    attempt: int,
    deferrals: int,
) -> None:
    """Fire a parent-bound task: gate per owner, then start its Helper.

    Gating (recorded as a ``skipped`` run with an ``error_code``):

    * proactivity ``off`` -> ``proactivity_off`` (skipped).
    * inside the owner's quiet hours -> ``quiet_hours_deferred``; one re-fire is
      armed for the end of the window.
    * another parent-bound run of the owner in flight -> ``owner_busy_deferred``
      (re-fire in 5 minutes, up to 3 times), then ``owner_busy`` (skipped).

    A failed launch records a ``failed`` run and arms one retry 10 minutes later
    (``attempt`` 2), unless the owner's proactivity is ``low``.
    """
    owner = task.user_id or RESERVED_USER_LOCAL
    prefs = await asyncio.to_thread(deps.scheduled_task_store.get_owner_preferences, owner)
    prefs = prefs or OwnerPreferences(user_id=owner)

    async def skip(code: str, error: str) -> None:
        await fire._record_run(
            deps,
            task,
            None,
            scheduled_at,
            status="skipped",
            error=error,
            error_code=code,
            attempt=attempt,
        )

    if deps.objective_store is not None:
        objective = await asyncio.to_thread(deps.objective_store.get_by_scheduled_task_id, task.id)
        if objective is not None and objective.status != "active":
            await skip("objective_inactive", f"objective is {objective.status}")
            return

    if prefs.proactivity == "off":
        await skip("proactivity_off", "proactivity is off for the task owner")
        return

    now = time.time()
    quiet_end = _quiet_window_end(prefs, now)
    if quiet_end is not None:
        armed = _schedule_refire(
            deps,
            task.workspace_id,
            task.id,
            fire_dispatch,
            delay_s=quiet_end - now,
            attempt=attempt,
            deferrals=deferrals,
        )
        await skip(
            "quiet_hours_deferred" if armed else "quiet_hours",
            "inside the owner's quiet hours"
            + (
                f"; re-fire at {datetime.fromtimestamp(quiet_end).astimezone().isoformat()}"
                if armed
                else ""
            ),
        )
        return

    owner_key = (task.workspace_id, owner)
    if owner_key in fire._OWNER_LAUNCHING or await _owner_has_proactive_run_in_flight(deps, task):
        if deferrals < fire._MAX_OWNER_BUSY_DEFERRALS and _schedule_refire(
            deps,
            task.workspace_id,
            task.id,
            fire_dispatch,
            delay_s=fire._OWNER_BUSY_DEFER_S,
            attempt=attempt,
            deferrals=deferrals + 1,
        ):
            await skip(
                "owner_busy_deferred",
                f"another proactive run is in flight; re-fire in {fire._OWNER_BUSY_DEFER_S}s",
            )
        else:
            await skip("owner_busy", "another proactive run is in flight")
        return

    fire._OWNER_LAUNCHING.add(owner_key)
    try:
        await _launch_helper(
            deps,
            task,
            fire_dispatch,
            scheduled_at,
            attempt=attempt,
            retry=prefs.proactivity != "low",
        )
    finally:
        fire._OWNER_LAUNCHING.discard(owner_key)


_DEFAULT_FAILURE_REASON = "it could not be started"


def _sentence(reason: str) -> str:
    """*reason* as a capitalised sentence."""
    return reason[:1].upper() + reason[1:] + ("" if reason.endswith(".") else ".")


async def _create_failed_helper_session(
    deps: FireDeps, task: ScheduledTask, scheduled_at: int
) -> str | None:
    """Create the Helper session a run that never started reports its failure on, if possible."""
    try:
        conv = await _create_helper_session(deps, task, scheduled_at)
        await fire._grant_owner(deps, task, conv.id)
        return conv.id
    except Exception:
        _logger.exception("scheduled fire: could not record a failed Helper for task %s", task.id)
        return None


async def _mark_helper_failed(deps: FireDeps, conv_id: str, message: str) -> None:
    """Make a Helper that never ran read as failed, with *message* as its reason."""
    from omnigent.entities import ErrorData, NewConversationItem
    from omnigent.server.routes._sessions.helpers import _publish_external_conversation_item

    try:
        persisted = await asyncio.to_thread(
            deps.conversation_store.append,
            conv_id,
            [
                NewConversationItem(
                    type="error",
                    response_id=fire._new_id(),
                    data=ErrorData(
                        source="execution", code="scheduled_run_failed", message=message
                    ),
                )
            ],
        )
        await asyncio.to_thread(deps.conversation_store.set_session_live_status, conv_id, "failed")
        if persisted:
            _publish_external_conversation_item(conv_id, persisted[0])
    except Exception:
        _logger.exception("scheduled fire: could not mark helper %s failed", conv_id)


async def _post_failure_note(deps: FireDeps, task: ScheduledTask, reason: str) -> None:
    """Tell the person, in the parent Conversation, that a scheduled run could not run.

    A calm system item rather than a Result wake: the wake would need the parent's runner,
    which is the thing that was down.
    """
    from omnigent.entities import ErrorData, NewConversationItem
    from omnigent.server.routes._sessions.helpers import _publish_external_conversation_item

    assert task.parent_session_id is not None
    again = "I'll try again at the next scheduled time."
    try:
        nxt = get_next_fire_time(
            task.rrule, datetime.now(ZoneInfo(task.timezone)), ZoneInfo(task.timezone)
        )
    except (ValueError, ZoneInfoNotFoundError, RRuleValidationError):
        nxt = None
    if task.rrule and nxt is None:
        again = "It has no more scheduled runs."
    message = f"Your {task.name} couldn't run: {reason}. {again}"
    try:
        persisted = await asyncio.to_thread(
            deps.conversation_store.append,
            task.parent_session_id,
            [
                NewConversationItem(
                    type="error",
                    response_id=fire._new_id(),
                    data=ErrorData(
                        source="execution",
                        code="scheduled_run_failed",
                        message=message,
                        level="info",
                    ),
                )
            ],
        )
        if persisted:
            _publish_external_conversation_item(task.parent_session_id, persisted[0])
    except Exception:
        _logger.exception("scheduled fire: could not post the failure note for task %s", task.id)


# How long a scheduled Helper run waits for its parent's Computer to wake and its runner connect.
_PARENT_WAKE_TIMEOUT_S = 120.0


async def _wake_parent_runner(deps: FireDeps, parent: Conversation) -> Conversation:
    """Bring the parent's runner online, waking its sleeping managed Computer first.

    Reuses the path a user message takes (:func:`ensure_runner_connected`: resume or relaunch the
    managed sandbox, launch a runner on it, wait for the tunnel), so a scheduled run needs no
    separate launch logic. A parent whose runner is already connected returns at once.

    :returns: The parent row re-read after the wake (its runner id may have been rebound).
    :raises RuntimeError: When the Computer could not be brought online.
    """
    from omnigent.server.routes._sessions.orchestration import ensure_runner_connected

    if deps.app_state is None:  # embedders without server wiring have nothing to wake
        return parent
    try:
        client, woken = await asyncio.wait_for(
            ensure_runner_connected(
                session_id=parent.id,
                conv=parent,
                app_state=deps.app_state,
                conversation_store=deps.conversation_store,
                runner_router=deps.runner_router,
            ),
            timeout=_PARENT_WAKE_TIMEOUT_S,
        )
    except TimeoutError as exc:
        raise RuntimeError("your Computer didn't start in time") from exc
    except OmnigentError as exc:
        raise RuntimeError(f"your Computer didn't start: {exc.message}") from exc
    if client is None:
        raise RuntimeError("your Computer didn't start: the parent's runner is not connected")
    return woken


async def _launch_helper(
    deps: FireDeps,
    task: ScheduledTask,
    fire_dispatch: _FireDispatch,
    scheduled_at: int,
    *,
    attempt: int,
    retry: bool,
) -> None:
    """Create the Helper child of the task's parent, dispatch its prompt, record the run."""
    conv_id: str | None = None

    async def fail(
        error: str, code: str, *, retryable: bool, reason: str = _DEFAULT_FAILURE_REASON
    ) -> None:
        nonlocal conv_id
        note = ""
        retry_armed = False
        if retryable and retry and attempt < fire._MAX_ATTEMPTS:
            if _schedule_refire(
                deps,
                task.workspace_id,
                task.id,
                fire_dispatch,
                delay_s=fire._RETRY_BACKOFF_S,
                attempt=attempt + 1,
                deferrals=0,
            ):
                retry_armed = True
                note = f"; retry scheduled in {fire._RETRY_BACKOFF_S}s"
        _logger.warning("scheduled fire: task %s helper fire failed: %s%s", task.id, error, note)
        # The run must read as failed in Activity: mark its Helper failed (creating one on the
        # final attempt when the failure came before any was made), with the reason as its outcome.
        if conv_id is None and not retry_armed:
            conv_id = await _create_failed_helper_session(deps, task, scheduled_at)
        if conv_id is not None:
            await _mark_helper_failed(deps, conv_id, _sentence(reason))
        await fire._record_run(
            deps,
            task,
            conv_id,
            scheduled_at,
            status="failed",
            error=error + note,
            error_code=code,
            attempt=attempt,
        )
        if not retry_armed:
            await _post_failure_note(deps, task, reason)

    assert task.parent_session_id is not None and task.agent_type is not None
    parent = await asyncio.to_thread(
        deps.conversation_store.get_conversation, task.parent_session_id
    )
    if parent is None or parent.agent_id is None:
        await fail("parent session no longer exists", "parent_not_found", retryable=False)
        return
    try:
        from omnigent.server.routes._sessions.helpers import _require_declared_subagent

        agent = await asyncio.to_thread(deps.agent_store.get, parent.agent_id)
        if agent is not None:
            await asyncio.to_thread(
                _require_declared_subagent,
                agent=agent,
                sub_agent_name=scheduled_helper_type(task.agent_type),
                agent_cache=deps.agent_cache,
            )
    except OmnigentError as exc:
        await fail(exc.message, "invalid_agent_type", retryable=False)
        return

    try:
        await _wake_parent_runner(deps, parent)
    except Exception as exc:
        _logger.exception("scheduled fire: task %s could not wake the parent runner", task.id)
        await fail(
            f"helper launch/dispatch failed: {exc}",
            "launch_failed",
            retryable=True,
            reason="your Computer didn't start",
        )
        return

    try:
        conv = await fire._create_session(deps, task, scheduled_at=scheduled_at)
    except Exception:
        _logger.exception("scheduled fire: failed to create helper for task %s", task.id)
        await fail("session creation failed", "session_create_failed", retryable=True)
        return
    conv_id = conv.id
    await fire._attach_cost_budget(deps, task, conv.id)
    # Same grant a ``sys_session_create`` child gets (its creator owns it):
    # the owner-scoped memory routes resolve the session owner from the
    # child's own grants, so a grantless Helper 403s on ``memory/profile``.
    try:
        await fire._grant_owner(deps, task, conv.id)
    except Exception:
        _logger.exception("scheduled fire: owner grant failed for helper %s", conv.id)
    dispatch = fire_dispatch.helper or fire_dispatch.connected
    try:
        await dispatch(conv, task)
    except Exception as exc:
        _logger.exception("scheduled fire: helper dispatch failed for task %s", task.id)
        await fail(f"helper launch/dispatch failed: {exc}", "launch_failed", retryable=True)
        return
    await fire._record_run(deps, task, conv.id, scheduled_at, status="running", attempt=attempt)
    _logger.info("scheduled fire: task %s started helper %s", task.id, conv.id)


async def _helper_harness(deps: FireDeps, parent: Conversation, sub_agent_name: str) -> str | None:
    """The harness the bundle gives the Helper Type ``sub_agent_name`` (``None`` if unknown)."""
    if deps.agent_cache is None or parent.agent_id is None:
        return None
    from omnigent.models.model_catalog import spec_harness
    from omnigent.runtime.workflow import _find_spec_by_name

    try:
        agent = await asyncio.to_thread(deps.agent_store.get, parent.agent_id)
        if agent is None:
            return None
        loaded = await asyncio.to_thread(deps.agent_cache.load, agent.id, agent.bundle_location)
        sub = _find_spec_by_name(loaded.spec, sub_agent_name)
        return spec_harness(sub) if sub is not None else None
    except Exception:
        _logger.exception("scheduled fire: could not resolve the Helper harness; using defaults")
        return None


async def _create_helper_session(
    deps: FireDeps, task: ScheduledTask, scheduled_at: int, *, wake_parent: bool = True
) -> Conversation:
    """Create the task's Helper as a sub-agent child of its parent session.

    Mirrors a ``sys_session_create`` child: ``kind="sub_agent"``, the parent's
    agent and runner (co-location), ``sub_agent_name`` = the Type, the parent's
    context-mode labels, and a dispatch id so a Result the parent has not drained
    is recovered. The scheduled-task label lets the runner register the Result
    for the parent wake on the child's first turn.
    """
    assert task.parent_session_id is not None
    parent = await asyncio.to_thread(
        deps.conversation_store.get_conversation, task.parent_session_id
    )
    if parent is None:
        raise RuntimeError(f"parent session {task.parent_session_id!r} not found")
    labels = {
        **inheritable_context_labels(parent.labels),
        SUBAGENT_DISPATCH_ID_LABEL_KEY: f"subagent_{fire._new_id()[:12]}",
    }
    if wake_parent:
        labels[SCHEDULED_HELPER_LABEL_KEY] = task.id
    else:
        labels[ADHOC_HELPER_LABEL_KEY] = task.id
    # ``"<agent_type>:<task name>"``: Activity splits on the first colon, so it reads
    # "<Type>: <task name>" instead of an opaque id (format owned by superchat.activity.titles).
    run_type = scheduled_helper_type(task.agent_type)
    _, run_model = resolve_scheduled_helper(
        task.agent_type,
        task.model_override,
        harness=await _helper_harness(deps, parent, run_type),
    )
    # Nothing configured for this harness, or the owner's connection does not serve it: inherit
    # the parent's model like a dispatch does.
    from omnigent.server.routes.sandbox_inference import snapshot_serves_model

    if run_model is not None and not snapshot_serves_model(parent.inference_snapshot, run_model):
        run_model = None
    run_model = run_model or parent.model_override
    conv: Conversation | None = None
    for title in fire_title_candidates(task.agent_type, task.name, task.id, scheduled_at):
        try:
            conv = await asyncio.to_thread(
                deps.conversation_store.create_conversation,
                kind="sub_agent",
                title=title,
                parent_conversation_id=parent.id,
                agent_id=parent.agent_id,
                runner_id=parent.runner_id,
                sub_agent_name=run_type,
                labels=labels,
                model_override=run_model,
                reasoning_effort=task.reasoning_effort,
            )
            break
        except NameAlreadyExistsError:
            continue
    if conv is None:
        raise RuntimeError("helper title collision")
    return conv


def _make_parent_runner_dispatch(
    deps: FireDeps, *, event: SessionEventInput | None = None
) -> LaunchDispatch:
    """Build the Helper dispatch seam: send the prompt (or *event*) to the parent's own runner."""

    async def _dispatch(conv: Conversation, task: ScheduledTask) -> None:
        from omnigent.server.routes.sessions import (
            _dispatch_session_event_to_runner,
            _ensure_runner_relay_ready,
            _ensure_runner_session_initialized,
            _wait_for_runner_client,
        )

        if conv.runner_id is None:
            raise RuntimeError("the parent session has no runner")
        runner_client = await _wait_for_runner_client(
            conv.id,
            deps.runner_router,
            deps.tunnel_registry,
            runner_id=conv.runner_id,
            timeout_s=fire._RUNNER_CONNECT_TIMEOUT_S,
        )
        if runner_client is None:
            raise RuntimeError("the parent's runner is not connected")
        owner = task.user_id or RESERVED_USER_LOCAL
        fresh = await asyncio.to_thread(deps.conversation_store.get_conversation, conv.id)
        conv_for_dispatch = fresh or conv
        await _ensure_runner_session_initialized(
            conv.id, conv_for_dispatch, runner_client, deps.conversation_store
        )
        # Subscribe the server relay BEFORE the prompt goes out: the relay is
        # what sees the turn's idle/failed edge and flips the run row to
        # succeeded/failed. The parent's runner is already connected, so
        # nothing else starts a relay for this fresh child.
        await _ensure_runner_relay_ready(
            conv.id, conv_for_dispatch.runner_id, runner_client, deps.conversation_store
        )
        await _dispatch_session_event_to_runner(
            conv.id,
            conv_for_dispatch,
            event or fire._prompt_event(task.prompt),
            deps.conversation_store,
            runner_client,
            agent_name=None,
            file_store=deps.file_store,
            artifact_store=deps.artifact_store,
            created_by=owner,
            runner_router=deps.runner_router,
        )

    return _dispatch


async def start_adhoc_helper(
    deps: FireDeps,
    *,
    parent_session_id: str,
    agent_type: str,
    name: str,
    user_id: str | None,
    content: list[dict[str, Any]],
) -> str:
    """Start a Helper of a session for one piece of work now, outside any schedule.

    Unlike a scheduled fire it is not gated by the owner's proactivity or quiet hours (the person
    asked for the work), and its Result does not wake the parent: the work records its output
    itself (e.g. through a tool). *content* is the Helper's first message, as Responses content
    blocks (``input_text``, ``input_image``).

    :param deps: The server dependencies the fire path uses.
    :param parent_session_id: The session the Helper is a child of.
    :param agent_type: The declared Sub-agent Type to run, e.g. ``"teacher"``.
    :param name: Short title for the Helper's Activity entry.
    :param user_id: Owner for the Helper's grant; ``None`` in single-user mode.
    :param content: First message content blocks.
    :returns: The Helper's session id.
    :raises OmnigentError: When the Type is not declared by the parent's agent.
    :raises RuntimeError: When the parent is gone or its runner is not connected.
    """
    parent = await asyncio.to_thread(deps.conversation_store.get_conversation, parent_session_id)
    if parent is None or parent.agent_id is None:
        raise RuntimeError("parent session no longer exists")
    from omnigent.server.routes._sessions.helpers import _require_declared_subagent

    agent = await asyncio.to_thread(deps.agent_store.get, parent.agent_id)
    if agent is not None:
        await asyncio.to_thread(
            _require_declared_subagent,
            agent=agent,
            sub_agent_name=scheduled_helper_type(agent_type),
            agent_cache=deps.agent_cache,
        )
    task = ScheduledTask(
        id=fire._new_id(),
        name=name,
        prompt="",
        rrule="",
        user_id=user_id,
        agent_id=parent.agent_id,
        timezone="UTC",
        created_at=int(time.time()),
        parent_session_id=parent_session_id,
        agent_type=agent_type,
    )
    conv = await _create_helper_session(deps, task, int(time.time()), wake_parent=False)
    try:
        await fire._grant_owner(deps, task, conv.id)
    except Exception:
        _logger.exception("helper: owner grant failed for %s", conv.id)
    event = SessionEventInput(type="message", data={"role": "user", "content": content})
    await fire._make_parent_runner_dispatch(deps, event=event)(conv, task)
    return conv.id


# Imported last: ``fire`` imports this module for its names, so it must see them defined first.
from omnigent.server.scheduled import fire  # noqa: E402
