"""Runner FastAPI app — spawns harness subprocesses and dispatches to them.

Per ``designs/RUNNER.md`` §1, the runner owns harness subprocesses.
It resolves the harness type + spawn-env from the agent spec (either
via a spec_resolver callback for in-process use, or via
GET /v1/agents/{id}/contents for out-of-process use).
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import errno
import logging
import os
import shlex
import shutil
import sys
import time
import urllib.parse
import uuid
from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple, Protocol

from omnigent.util.json_types import JsonObject as _JsonObject

if TYPE_CHECKING:
    # Type-only import: the runner keeps codex deps out of its runtime import
    # graph (they are imported lazily inside the codex-native helpers).
    from omnigent.harnesses.claude_native.main import ClaudeNativeUcodeConfig
    from omnigent.harnesses.codex_native.app_server import (
        CodexAppServerClient,
        CodexNativeAppServer,
    )
    from omnigent.inner.datamodel import OSEnvSpec
    from omnigent.inner.terminal import TerminalInstance
    from omnigent.runner.turn_routing import TurnRouter

import click
import httpx
from fastapi.responses import JSONResponse, Response

from omnigent._platform import IS_WINDOWS, resolve_cli_binary
from omnigent.debug_logging import debug_event, runner_primary_session_id
from omnigent.entities.session_resources import (
    SessionResourceView,
    session_resource_view_to_dict,
    terminal_resource_id,
)
from omnigent.errors import ErrorCategory, ErrorCode, ErrorImpact, ErrorPhase, OmnigentError
from omnigent.harness_plugins import native_provider_for_key
from omnigent.models.model_override import validate_model_override
from omnigent.native.native_coding_agents import (
    native_coding_agent_for_harness,
    native_coding_agent_for_terminal_name,
)
from omnigent.native.native_dispatch import resolve_hook
from omnigent.process_logging import process_log_reference
from omnigent.runner.resource_registry import (
    CLAUDE_NATIVE_TERMINAL_ROLE,
    CODEX_NATIVE_TERMINAL_ROLE,
    OMNIGENT_REPL_TERMINAL_ROLE,
    PI_NATIVE_TERMINAL_ROLE,
    SessionResourceRegistry,
)
from omnigent.runner.session_init_protocol import (
    RunnerSessionInitEnvelope,
)
from omnigent.runner.transports.ws_tunnel.event_delivery import RunnerEventDispatcher
from omnigent.spec.types import AgentSpec

_logger = logging.getLogger("omnigent.runner.app")

#: Root of the installed ``omnigent`` package, for locating packaged assets
#: (e.g. ``onboarding/agent/skills/``) independently of this module's depth.
_OMNIGENT_PACKAGE_DIR = Path(__file__).resolve().parent.parent.parent

_NATIVE_TERMINAL_START_FAILED_CODE = "native_terminal_start_failed"

_REPL_TERMINAL_NAME = "tui"
_REPL_TERMINAL_SESSION_KEY = "main"
_NO_BODY_STATUS_CODES = {204, 304}


class _EnsureCommentRelay(Protocol):
    """Callable contract for starting a session's native tool relay."""

    async def __call__(
        self,
        session_id: str,
        *,
        bridge_id: str | None = None,
        explicit_bridge_dir: Path | None = None,
        await_notify: bool = False,
        session_labels: Mapping[str, str] | None = None,
    ) -> None:
        pass


def _publish_tmux_target_for_bridge(
    *,
    resource_registry: SessionResourceRegistry,
    session_id: str,
    bridge_id: str,
    terminal_name: str,
    session_key: str,
) -> None:
    """
    Advertise a launched terminal's tmux target to a bridge directory.

    Called from the terminal-launch POST when the caller opts in via
    truthy ``bridge_inject_dir`` in the body. The destination path is
    derived from a server-side bridge id, so a caller can't redirect
    the write.

    The ``claude-native`` harness reads ``tmux.json`` from the derived
    directory and shells out to ``tmux -S <socket> send-keys``. No-op
    if the registry has no live instance for the triple.

    :param resource_registry: Session resource registry that exposes
        the underlying terminal registry.
    :param session_id: Owning session/conversation id.
    :param bridge_id: Opaque bridge id from the session label, e.g.
        ``"bridge_abc123"``.
    :param terminal_name: Terminal spec name, e.g. ``"claude"``.
    :param session_key: Session key, e.g. ``"main"``.
    :returns: None.
    """
    terminal_registry = resource_registry.terminal_registry
    if terminal_registry is None:
        return
    instance = terminal_registry.get(session_id, terminal_name, session_key)
    if instance is None or not instance.running:
        return
    # Imported here to avoid pulling Claude-native specifics into the
    # generic runner module's import-time graph.
    from omnigent.harnesses.claude_native.bridge import bridge_dir_for_bridge_id, write_tmux_target

    write_tmux_target(
        bridge_dir_for_bridge_id(bridge_id),
        socket_path=instance.socket_path,
        tmux_target=instance.tmux_target,
    )


# Background transcript-forwarder tasks for host-spawned claude-native and
# codex-native runners, keyed by session id: strong references so they aren't
# garbage-collected mid-run, and the handle for cancelling a session's previous
# forwarder on terminal re-create (else both mirror, double-posting items).
_AUTO_FORWARDER_TASKS: dict[str, asyncio.Task[object]] = {}

# Include the child's 10-second termination grace and forced-exit cleanup.
_AUTO_FORWARDER_CANCEL_TIMEOUT_S = 15.0

# Delegated runner bearers last 30 minutes and refresh five minutes before
# expiry. A one-minute cadence allows several retries without giving the child
# the runner binding token; cached factory calls stay local and cheap.


class _CodexNativeModelOptionsNotReady(RuntimeError):
    """Raised when Codex model options are requested before bridge startup."""


async def _cancel_auto_forwarder_task(session_id: str) -> None:
    """
    Cancel and await the session's registered transcript forwarder, if any.

    Native terminal (re)creation calls this before wiping the bridge's
    forward-cursor state: the claude forwarder is restart-forever and tails
    the transcript file across pane death, so without an explicit cancel
    the surviving task keeps mirroring alongside the newly spawned one and
    every post-recovery record is persisted twice (the server has no dedup
    for external conversation items).

    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :returns: None.
    """
    task = _AUTO_FORWARDER_TASKS.pop(session_id, None)
    if task is None or task.done():
        return
    task.cancel()
    # asyncio.wait absorbs the CancelledError and bounds the wait on a hung cancellation.
    _done, pending = await asyncio.wait({task}, timeout=_AUTO_FORWARDER_CANCEL_TIMEOUT_S)
    if pending:
        _logger.warning(
            "Cancelled transcript forwarder for %s did not finish within %.0fs",
            session_id,
            _AUTO_FORWARDER_CANCEL_TIMEOUT_S,
        )


async def teardown_codex_native_app_server(session_id: str) -> None:
    """
    Tear down a host-spawned codex-native session's app-server subprocess.

    ``DELETE /v1/sessions``, runner shutdown, and the idle pane reaper use
    this helper for full native cleanup. An unexpected auxiliary-TUI exit
    deliberately leaves the app-server running so an active response is not
    cancelled; the next native-terminal ensure can recreate the TUI.

    Cancelling the forwarder closes the app-server via the forwarder's own
    ``finally`` (see :func:`_codex_discover_thread_and_forward`); the pop
    below is the belt-and-suspenders close for the discovery-failed case
    where no forwarder ever adopted the server. No-op for a session that
    has no registered codex app-server, so this is safe to call from the
    required-session teardown paths regardless of harness.

    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :returns: None.
    """
    if session_id not in _AUTO_CODEX_APP_SERVERS:
        return
    await _cancel_auto_forwarder_task(session_id)
    leftover_app_server = _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
    if leftover_app_server is not None:
        with contextlib.suppress(Exception):
            await leftover_app_server.close()


async def teardown_all_codex_native_app_servers() -> None:
    """
    Tear down every host-spawned codex-native app-server on this runner.

    Called from the runner's shutdown path (``_stop_pm``) so a graceful host
    or runner stop — the host SIGTERMs its runners on ``host.stop_runner`` and
    on its own exit — takes the per-session ``codex app-server`` subprocesses
    down with it. Each app-server is spawned ``start_new_session=True`` (its
    own process group), so it is NOT killed by the runner's death; without an
    explicit close here it is reparented to init and lingers as an orphaned
    ``codex`` process. Per-session teardown normally runs on
    ``DELETE /v1/sessions``, but a host stop tears the runner down without
    deleting each session first, so those never fire.

    Iterates a snapshot of the registered session ids and delegates to
    :func:`teardown_codex_native_app_server` (which cancels the forwarder and
    closes the server). Best-effort and idempotent: a session already torn
    down is a no-op.

    :returns: None.
    """
    for session_id in list(_AUTO_CODEX_APP_SERVERS):
        with contextlib.suppress(Exception):
            await teardown_codex_native_app_server(session_id)


def _register_auto_forwarder_task(session_id: str, task: asyncio.Task[object]) -> None:
    """
    Register a session's transcript-forwarder task in the keyed registry.

    Keeps a strong reference so the task isn't garbage-collected mid-run.
    If a different live task already occupies the slot (a concurrent
    create that slipped past :func:`_cancel_auto_forwarder_task`), it is
    cancelled so a session never runs two forwarders at once.

    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param task: Freshly created forwarder task for this session.
    :returns: None.
    """
    incumbent = _AUTO_FORWARDER_TASKS.get(session_id)
    if incumbent is not None and incumbent is not task:
        incumbent.cancel()
    _AUTO_FORWARDER_TASKS[session_id] = task

    def _evict(done_task: asyncio.Task[object]) -> None:
        """Drop the registry entry unless a successor already replaced it; log the exit."""
        if _AUTO_FORWARDER_TASKS.get(session_id) is done_task:
            del _AUTO_FORWARDER_TASKS[session_id]
        # Obituary: a stopped forwarder takes mirroring, status and the busy
        # signal with it, so no exit path may be silent. ``exception()`` also
        # retrieves the failure (no "Task exception was never retrieved").
        if done_task.cancelled():
            _logger.info(
                "Transcript forwarder task %s cancelled; session=%s",
                done_task.get_name(),
                session_id,
                extra={"session_id": session_id},
            )
        elif (exc := done_task.exception()) is not None:
            _logger.error(
                "Transcript forwarder task %s died; session mirroring is down "
                "until the terminal is recreated; session=%s",
                done_task.get_name(),
                session_id,
                exc_info=exc,
                extra={"session_id": session_id},
            )
        else:
            _logger.warning(
                "Transcript forwarder task %s returned; session mirroring has stopped; session=%s",
                done_task.get_name(),
                session_id,
                extra={"session_id": session_id},
            )

    task.add_done_callback(_evict)


# Background tasks that re-pop a still-pending cost-budget approval on a
# terminal client that attaches after the ASK fired. Kept referenced so
# they aren't garbage-collected before they run.
_COST_POPUP_REPOP_TASKS: set[asyncio.Task[object]] = set()

# One-shot readiness observers for runner-owned native terminals. Strong
# references keep the tasks alive after session creation returns.
_TERMINAL_INTERACTIVE_TASKS: set[asyncio.Task[None]] = set()
_TERMINAL_INTERACTIVE_TIMEOUT_S = 180.0
_TERMINAL_INTERACTIVE_POLL_INTERVAL_S = 0.15
# Sign-in may stay open indefinitely; limit its liveness subprocess rate.
_CODEX_LOGIN_EXIT_POLL_INTERVAL_S = 1.0
# How often a starting pane is read for a launcher sign-in prompt.
_CODEX_SIGN_IN_POLL_INTERVAL_S = 2.0

# Background Codex app-server instances for host-spawned codex-native
# runners, kept referenced so they aren't garbage-collected mid-run.
_AUTO_CODEX_APP_SERVERS: dict[str, CodexNativeAppServer] = {}

# Bound repeated terminal GET miss logs from tight client poll loops.
_TERMINAL_LOOKUP_MISS_LOG_INTERVAL_S = 10.0
_terminal_lookup_miss_log_state: dict[tuple[str, str, str], float] = {}


async def _observe_terminal_interactive(
    *,
    session_id: str,
    terminal_id: str,
    harness: str,
    readiness_signal: str,
    instance: TerminalInstance,
    is_interactive: Callable[[str], bool],
    timeout_s: float = _TERMINAL_INTERACTIVE_TIMEOUT_S,
    poll_interval_s: float = _TERMINAL_INTERACTIVE_POLL_INTERVAL_S,
) -> None:
    """Emit one semantic event when a native TUI can accept a message."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    try:
        while True:
            result = await instance.read()
            screen = result.get("screen")
            if isinstance(screen, str) and is_interactive(screen):
                _logger.info(
                    "Native terminal became interactive: session=%s harness=%s terminal_id=%s",
                    session_id,
                    harness,
                    terminal_id,
                    extra=debug_event(
                        "terminal_interactive",
                        session_id=session_id,
                        harness=harness,
                        terminal_id=terminal_id,
                        terminal_instance_id=instance.diagnostic_id,
                        readiness_signal=readiness_signal,
                    ),
                )
                return
            if not instance.running:
                raise RuntimeError("terminal stopped before becoming interactive")
            if loop.time() >= deadline:
                raise TimeoutError(f"terminal did not become interactive within {timeout_s:g}s")
            await asyncio.sleep(poll_interval_s)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — observer failure must not fail session creation
        _logger.warning(
            "Native terminal interactivity was not observed: session=%s harness=%s "
            "terminal_id=%s reason=%s",
            session_id,
            harness,
            terminal_id,
            str(exc),
            extra=debug_event(
                "terminal_interactive_unobserved",
                session_id=session_id,
                harness=harness,
                terminal_id=terminal_id,
                terminal_instance_id=instance.diagnostic_id,
                readiness_signal=readiness_signal,
                reason=type(exc).__name__,
            ),
        )


def _schedule_terminal_interactive_observer(
    *,
    session_id: str,
    resource_registry: SessionResourceRegistry,
    terminal_name: str,
    session_key: str,
    harness: str,
    readiness_signal: str,
    is_interactive: Callable[[str], bool],
) -> None:
    """Start a non-blocking readiness observer for a registered terminal."""
    terminal_registry = getattr(resource_registry, "terminal_registry", None)
    if terminal_registry is None:
        return
    instance = terminal_registry.get(session_id, terminal_name, session_key)
    if instance is None:
        _logger.warning(
            "Cannot observe native terminal interactivity: terminal is not registered; "
            "session=%s harness=%s terminal=%s:%s",
            session_id,
            harness,
            terminal_name,
            session_key,
            extra={"session_id": session_id},
        )
        return
    terminal_id = terminal_resource_id(terminal_name, session_key)
    task = asyncio.create_task(
        _observe_terminal_interactive(
            session_id=session_id,
            terminal_id=terminal_id,
            harness=harness,
            readiness_signal=readiness_signal,
            instance=instance,
            is_interactive=is_interactive,
        ),
        name=f"terminal-interactive-{session_id}-{terminal_name}",
    )
    _TERMINAL_INTERACTIVE_TASKS.add(task)
    task.add_done_callback(_TERMINAL_INTERACTIVE_TASKS.discard)


def _terminal_lookup_miss_reason(
    resource_registry: SessionResourceRegistry,
    session_id: str,
    terminal_id: str,
) -> str:
    """
    Explain why a terminal resource lookup returned ``None``.

    Used only for runner diagnostics after
    :meth:`SessionResourceRegistry.get_terminal_resource` has already
    performed the authoritative lookup and tmux liveness probe. The helper
    inspects in-memory registry state without running another tmux command,
    so the log line distinguishes absent resources from terminals that were
    registered but are now marked stopped.

    :param resource_registry: Runner resource registry for the session.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param terminal_id: Terminal resource id, e.g.
        ``"terminal_claude_main"``.
    :returns: Short reason string for logs.
    """
    terminal_registry = resource_registry.terminal_registry
    if terminal_registry is None:
        return "terminal_registry_missing"
    entries = terminal_registry.list_for_conversation(session_id)
    if not entries:
        return "session_has_no_registered_terminals"
    registered_ids = [
        terminal_resource_id(entry.terminal_name, entry.session_key) for entry in entries
    ]
    for entry in entries:
        if terminal_resource_id(entry.terminal_name, entry.session_key) != terminal_id:
            continue
        if not entry.instance.running:
            return (
                "terminal_registered_but_not_running "
                f"name={entry.terminal_name!r} session_key={entry.session_key!r} "
                f"socket={entry.instance.socket_path}"
            )
        return (
            "terminal_registered_but_liveness_probe_failed "
            f"name={entry.terminal_name!r} session_key={entry.session_key!r} "
            f"socket={entry.instance.socket_path}"
        )
    return f"terminal_id_not_registered registered_ids={registered_ids!r}"


def _log_terminal_lookup_miss(
    resource_registry: SessionResourceRegistry,
    session_id: str,
    terminal_id: str,
) -> None:
    """
    Log a throttled terminal lookup miss diagnostic.

    Claude/Codex wrapper clients poll terminal GET endpoints while a runner
    starts. Without throttling, an INFO log per poll would flood the runner
    log for the full startup timeout. This emits immediately for each new
    reason and then at most once per interval while the reason persists.

    :param resource_registry: Runner resource registry for the session.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param terminal_id: Terminal resource id, e.g.
        ``"terminal_claude_main"``.
    :returns: None.
    """
    reason = _terminal_lookup_miss_reason(resource_registry, session_id, terminal_id)
    now = time.monotonic()
    key = (session_id, terminal_id, reason)
    last = _terminal_lookup_miss_log_state.get(key)
    if last is not None and now - last < _TERMINAL_LOOKUP_MISS_LOG_INTERVAL_S:
        return
    _terminal_lookup_miss_log_state[key] = now
    _logger.info(
        "Terminal resource lookup miss: session=%s terminal_id=%s reason=%s",
        session_id,
        terminal_id,
        reason,
        extra={"session_id": session_id},
    )


@dataclasses.dataclass(frozen=True)
class _CodexNativeLaunchConfig:
    """
    Persisted launch config needed for runner-owned Codex terminal setup.

    :param workspace: Workspace cwd for the Codex app-server and TUI,
        e.g. ``Path("/Users/me/repo")``.
    :param policy_server_url: Omnigent server URL for the Codex policy hook and
        forwarder, e.g. ``"http://127.0.0.1:8123"``.
    :param terminal_launch_args: User pass-through Codex CLI args, e.g.
        ``["--config", "approval_policy=on-request"]``.
    :param model_override: Persisted model override, e.g.
        ``"gpt-5.4-mini"``.
    :param external_session_id: Existing Codex thread id to resume, e.g.
        ``"thread_abc123"``.
    :param fork_source_id: SOURCE conversation id stamped on a forked
        clone (``omnigent.fork.source_id``), used to locate the
        source's ``CODEX_HOME`` when cloning its rollout, e.g.
        ``"conv_source"``. ``None`` when the session is not a fork.
    :param fork_source_external_id: SOURCE Codex thread id stamped on a
        forked clone (``omnigent.fork.source_external_session_id``),
        e.g. ``"019e96aa-..."``. ``None`` when the source had no captured
        thread id (the clone then resumes fresh).
    :param fork_carry_history: ``True`` on a forked clone bound to a
        native target (``omnigent.fork.carry_history``); when no source
        rollout exists to clone (an SDK or cross-family source) the runner
        builds the clone's rollout from the copied Omnigent items instead (see
        ``_ensure_local_codex_resume_rollout``).
    :param bypass_sandbox: ``True`` when the session opted into Codex's
        DANGEROUS full-bypass stance (``omnigent.codex_native.bypass_sandbox``
        label == ``"1"``). The runner then launches the ``--remote`` TUI with
        ``--dangerously-bypass-approvals-and-sandbox`` and aligns the
        app-server threads (no approval prompts, no command sandbox). Default
        ``False``. See issue #657.
    :param routing_enabled: ``True`` when the session launched with Smart
        Routing on (pinned or auto-harness). Gates the first-message
        turn-routing endpoint, whose advertisement in turn gates the
        ``UserPromptSubmit`` routing hook, and the extended model catalog a
        routed turn may need.
    :param turn_routing: ``True`` when the first-message turn-routing endpoint
        still has work to do. False on a session something already routed —
        a web create that pinned the model before the pane launched — so the
        ``UserPromptSubmit`` hook is never registered and no prompt is held.
    :param reasoning_effort: Persisted per-session effort, e.g. ``"ultra"``,
        pinned into the private ``config.toml`` at launch so the thread (and
        the TUI footer) start at it instead of the shared config's default.
        ``None`` leaves Codex's configured effort in place.
    :param compact_at_tokens: A rollover session's threshold
        (``omnigent.context.mode=rollover``): Codex's own auto-compaction is
        set to fire there. ``None`` leaves it untouched.
    """

    workspace: Path
    policy_server_url: str
    terminal_launch_args: list[str] | None
    model_override: str | None
    external_session_id: str | None
    fork_source_id: str | None
    fork_source_external_id: str | None
    fork_carry_history: bool
    bypass_sandbox: bool
    routing_enabled: bool = False
    turn_routing: bool = False
    reasoning_effort: str | None = None
    compact_at_tokens: int | None = None


def _rollover_compact_at(
    labels: Mapping[str, str] | None, *, model: str | None = None
) -> int | None:
    """A rollover session's compaction threshold, or ``None`` outside rollover.

    :param model: The session's launch model, used to look up its context
        window when no window has been reported yet. A lookup failure (e.g.
        an unrecognized id) is treated as "unknown", not a launch error.
    """
    from omnigent.context.labels import is_rollover
    from omnigent.context.rollover import resolve_rollover_threshold

    if not is_rollover(labels):
        return None
    window: int | None = None
    if model:
        from omnigent.llms.context_window import find_model_context_window

        try:
            window = find_model_context_window(model)
        except Exception:  # noqa: BLE001 — an unresolvable model just means no window
            window = None
    return resolve_rollover_threshold(labels, model_window=window)


def _codex_launch_model_hint(
    model_override: str | None, terminal_launch_args: list[str] | None
) -> str | None:
    """Best-effort model id for a Codex launch, read from launch args.

    Only for sizing the rollover threshold before the real provider/catalog
    resolution runs (see :func:`_auto_create_codex_terminal`): an explicit
    ``--model``/``-m`` or ``-c model=...``/``--config model=...`` override in
    the user's pass-through args wins, else the persisted per-session
    ``model_override``, else ``None``.
    """
    args = terminal_launch_args or []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--model", "-m") and index + 1 < len(args):
            return args[index + 1]
        if arg.startswith("--model="):
            return arg.split("=", 1)[1]
        if arg in ("-c", "--config") and index + 1 < len(args):
            index += 1
            key, _, value = args[index].partition("=")
            if key.strip() == "model":
                return value.strip().strip("\"'")
        elif arg.startswith(("-c=", "--config=")):
            key, _, value = arg.split("=", 1)[1].partition("=")
            if key.strip() == "model":
                return value.strip().strip("\"'")
        index += 1
    return model_override


@dataclasses.dataclass(frozen=True)
class _PiNativeLaunchConfig:
    """
    Persisted launch config read from a session snapshot for native terminals.

    A session-snapshot reader for the pi-native launch path (workspace +
    terminal_launch_args + model_override). Pi-native uses ``model_override``
    as ``--model`` (overrides the spec's pinned model).

    :param workspace: Workspace cwd for the native TUI.
    :param server_url: Omnigent server URL for the extension/forwarder.
    :param terminal_launch_args: User pass-through native CLI args.
    :param external_session_id: Existing external session id, when captured by
        the extension.
    :param fork_source_external_id: SOURCE Pi session id stamped on a forked
        clone (``omnigent.fork.source_external_session_id``); consulted only
        when the clone has no native session of its own yet.
    :param fork_carry_history: ``True`` on a forked clone bound to a native
        target (``omnigent.fork.carry_history``); when no source session
        exists to clone, the clone's session is rebuilt from its OWN copied
        Omnigent items (see :func:`_auto_create_pi_terminal`).
    :param model_override: Persisted per-session ``/model`` override, e.g.
        ``"claude-4.6-sonnet-medium"``; ``None`` when unset. Consumed by
        pi-native as the model selection threaded into the launch.
    :param reasoning_effort: Persisted per-session effort, e.g. ``"high"``.
        Consumed by the pi-native launch as ``--thinking``; ``None`` leaves
        Pi's model default in place.
    :param labels: The session's labels. Consumed by the pi-native launch to
        gate rollover mode (``omnigent.context.labels.is_rollover``): the
        resident extension's ``session_before_compact`` handler and Pi's own
        ``compaction`` settings overlay.
    """

    workspace: Path
    server_url: str
    terminal_launch_args: list[str] | None
    external_session_id: str | None
    fork_source_id: str | None = None
    fork_source_external_id: str | None = None
    fork_carry_history: bool = False
    model_override: str | None = None
    reasoning_effort: str | None = None
    labels: dict[str, str] | None = None


def _start_turn_router_for_native_session(
    session_id: str,
    *,
    bridge_dir: Path,
    harness: str,
    server_client: httpx.AsyncClient | None,
    turn_routing: bool,
) -> TurnRouter | None:
    """Start the first-message turn-routing endpoint for a native session.

    Installed only for a session whose first prompt still has to be routed.
    The advertisement it writes is also the switch the harness launch reads to
    decide whether to register the ``UserPromptSubmit`` routing hook at all,
    so a session that will never route pays no round trip — neither one with
    routing off, nor one a web create already routed before the pane launched.

    :param session_id: Session/conversation identifier.
    :param bridge_dir: Session bridge directory the hook discovers.
    :param harness: Harness the endpoint is being installed for.
    :param server_client: Runner→server client the relay forwards on, and
        the replay delivers through.
    :param turn_routing: Whether this session still needs first-message
        routing (:class:`~omnigent.runner.subagent_routing.SessionRoutingClass`).
    :returns: The router handle, or ``None`` when nothing is left to route
        for this session or the endpoint could not start.
    """
    from omnigent.runner.turn_routing import ensure_session_turn_router

    return ensure_session_turn_router(
        session_id,
        bridge_dir=bridge_dir,
        server_client=server_client,
        harness=harness,
        routing_enabled=turn_routing,
    )


def _recover_pending_turn_replay(
    session_id: str,
    *,
    bridge_dir: Path,
    server_client: httpx.AsyncClient | None,
) -> None:
    """Redeliver a routed prompt a previous launch blocked but never replayed.

    Fire-and-forget and best effort: no pending record (the normal case) is
    a no-op, and a recovery that cannot run must never fail a launch.

    :param session_id: Session/conversation identifier.
    :param bridge_dir: Session bridge directory holding the pending record.
    :param server_client: Runner→server client the prompt is delivered on.
    :returns: None.
    """
    from omnigent.runner.turn_routing import schedule_pending_replay_recovery

    try:
        schedule_pending_replay_recovery(
            session_id,
            bridge_dir=bridge_dir,
            server_client=server_client,
        )
    except Exception:
        _logger.warning(
            "turn-routing replay recovery could not start for session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )


async def _shutdown_session_turn_router_async(
    session_id: str, router: TurnRouter | None = None
) -> None:
    """Tear down a session's turn-routing endpoint off the event loop.

    :param session_id: Session/conversation identifier.
    :param router: Handle this launch started, so a late teardown cannot
        close the endpoint a re-created terminal has since installed.
    :returns: None.
    """
    from omnigent.runner.turn_routing import shutdown_session_turn_router

    await asyncio.to_thread(shutdown_session_turn_router, session_id, router)


def _required_runner_env(name: str) -> str:
    """
    Return a required runner environment variable.

    :param name: Environment variable name, e.g. ``"RUNNER_SERVER_URL"``.
    :returns: Non-empty environment variable value.
    :raises RuntimeError: If the variable is missing or empty.
    """
    value = os.environ.get(name)
    if value is None or not value:
        raise RuntimeError(f"{name} must be set for runner-owned Codex terminals.")
    return value


def _runner_workspace_dir() -> str:
    """
    Resolve the runner's workspace for a native-terminal launch.

    ``OMNIGENT_RUNNER_WORKSPACE`` is authoritative. The process cwd is only a
    fallback for in-process setups that never export it, and reading it can
    itself fail: a session whose worktree was removed under the runner makes
    ``Path.cwd()`` raise ``FileNotFoundError``. So cwd is consulted only when
    the variable is absent, and its failure is reported as the missing-workspace
    condition it is rather than an opaque ``[Errno 2]`` from ``os.getcwd()``.

    :returns: Absolute workspace path used as the terminal's cwd.
    :raises RuntimeError: If neither the variable nor the process cwd resolves.
    """
    workspace = os.environ.get("OMNIGENT_RUNNER_WORKSPACE")
    if workspace:
        return workspace
    try:
        return str(Path.cwd())
    except OSError as exc:
        raise RuntimeError(
            "Cannot resolve a workspace for the native terminal: "
            "OMNIGENT_RUNNER_WORKSPACE is unset and the runner's working "
            "directory no longer exists."
        ) from exc


def _codex_session_workspace(session_workspace: str | None) -> Path:
    """
    Resolve the cwd for a runner-owned Codex terminal.

    Mirrors :func:`_auto_create_claude_terminal`'s workspace
    resolution and the per-session filesystem registry
    (``_resolve_session_fs_registry``): the server-stored session
    ``workspace`` wins (it holds the git-worktree path for worktree
    sessions, or the repo root otherwise), falling back to the
    runner's ``OMNIGENT_RUNNER_WORKSPACE``.

    Deliberately does NOT consult ``ResolvedSpec.workdir`` — in the
    out-of-process runner that is the agent-bundle extraction dir
    (``runner-specs-<id>/ag_<id>-v<ver>``), not the repo, so using it
    stranded Codex in a temp dir with no ``.git`` (and ignored the
    worktree entirely).

    Normalizes the chosen value with ``strip().expanduser().resolve()``,
    matching the runner entrypoint's ``_runner_workspace_from_env`` and the
    per-session filesystem registry's ``Path(...).resolve()`` so a padded or
    ``~``-prefixed value can't yield a non-existent cwd or diverge from the
    path the Files panel watches.

    :param session_workspace: The session's ``workspace`` from
        ``GET /v1/sessions/{id}``, e.g.
        ``"/Users/me/repo-worktrees/feature-x"``. ``None`` when the
        snapshot omits it.
    :returns: Workspace path for the terminal cwd.
    :raises RuntimeError: If no workspace is available (neither the
        session snapshot nor ``OMNIGENT_RUNNER_WORKSPACE``).
    """
    raw = session_workspace or _required_runner_env("OMNIGENT_RUNNER_WORKSPACE")
    return Path(raw.strip()).expanduser().resolve()


def _pi_session_workspace(session_workspace: str | None) -> Path:
    """
    Resolve the cwd for a runner-owned Pi terminal.

    :param session_workspace: Session ``workspace`` from the server snapshot.
    :returns: Workspace path for the terminal cwd.
    """
    raw = session_workspace or _required_runner_env("OMNIGENT_RUNNER_WORKSPACE")
    return Path(raw.strip()).expanduser().resolve()


# A runner->server ``GET /v1/sessions/<id>`` launch-config read can time out
# under load. Left un-retried it fails Codex terminal launch, ensure, and the
# next turn from one blip; a bounded retry rides it out (the read is idempotent)
# before surfacing a server-attributed hard error, so persistent cases fail loud.
_LAUNCH_CONFIG_FETCH_TIMEOUT_S = 10.0
_LAUNCH_CONFIG_FETCH_ATTEMPTS = 3
_LAUNCH_CONFIG_FETCH_BACKOFF_BASE_S = 0.5
_LAUNCH_CONFIG_FETCH_BACKOFF_CAP_S = 4.0
_LAUNCH_CONFIG_RETRYABLE_STATUS = frozenset({429, 502, 503, 504})


def _launch_config_fetch_is_transient(exc: httpx.HTTPError) -> bool:
    """Whether a launch-config fetch HTTP error is a transient, retryable condition.

    :param exc: The ``httpx`` error raised by the snapshot GET.
    :returns: ``True`` for read/connect/protocol failures that a retry may
        clear (the deployed ``httpx.ReadTimeout`` among them); ``False`` for
        anything else, which is surfaced immediately.
    """
    return isinstance(
        exc,
        (
            httpx.TimeoutException,
            httpx.ConnectError,
            httpx.ReadError,
            httpx.WriteError,
            httpx.RemoteProtocolError,
        ),
    )


async def _launch_config_retry_sleep(delay: float) -> None:
    """Sleep between launch-config fetch attempts (patched to a no-op in tests)."""
    await asyncio.sleep(delay)


# Metadata reads do not need transcript, liveness, or subtree-usage aggregation.
_SESSION_METADATA_PARAMS: dict[str, str] = {
    "include_items": "false",
    "include_liveness": "false",
    "include_usage": "false",
}


async def _fetch_native_launch_snapshot(
    *,
    server_client: httpx.AsyncClient | None,
    session_id: str,
    runtime_label: str,
) -> dict[str, Any]:
    """Fetch and validate a session snapshot for a native-terminal launch config.

    Reads ``GET /v1/sessions/<id>`` and returns the parsed snapshot object.
    A transient runner->server condition (a read/connect timeout, or a
    ``429``/``502``/``503``/``504``) is retried with bounded exponential
    backoff so one blip under load does not tear through native terminal
    launch, ensure, and the next turn. A persistent transient failure, a 5xx,
    or a malformed body raises a server-attributed ``OmnigentError`` so
    startup-reliability signals count it as a platform fault.

    :param server_client: Runner's Omnigent server HTTP client.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param runtime_label: Human-readable harness name for error text, e.g.
        ``"Codex"``.
    :returns: The snapshot mapping.
    :raises OmnigentError: Server-attributed (blocking, harness setup) when
        retries are exhausted, the server returns a 5xx, or the body is not a
        JSON object.
    :raises RuntimeError: If the client is missing, or on a client-side 4xx
        or non-transient transport error.
    """
    if server_client is None:
        raise RuntimeError(
            f"server_client is required for runner-owned {runtime_label} terminals."
        )
    path = f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}"
    resp: httpx.Response | None = None
    for attempt in range(1, _LAUNCH_CONFIG_FETCH_ATTEMPTS + 1):
        last_attempt = attempt == _LAUNCH_CONFIG_FETCH_ATTEMPTS
        try:
            resp = await server_client.get(
                path, params=_SESSION_METADATA_PARAMS, timeout=_LAUNCH_CONFIG_FETCH_TIMEOUT_S
            )
        except httpx.HTTPError as exc:
            transient = _launch_config_fetch_is_transient(exc)
            if last_attempt or not transient:
                message = f"Could not fetch {runtime_label} launch config for {session_id!r}."
                # Exhausted timeouts/disconnects mean our server never answered.
                if transient:
                    raise OmnigentError(
                        message,
                        category=ErrorCategory.SERVER,
                        impact=ErrorImpact.BLOCKING,
                        phase=ErrorPhase.HARNESS_SETUP,
                    ) from exc
                raise RuntimeError(message) from exc
            _logger.warning(
                "Transient %s launch-config fetch error (attempt %d/%d) for "
                "session=%s; retrying: %s",
                runtime_label,
                attempt,
                _LAUNCH_CONFIG_FETCH_ATTEMPTS,
                session_id,
                type(exc).__name__,
                extra={"session_id": session_id},
            )
        else:
            if resp.status_code == 200:
                break
            if last_attempt or resp.status_code not in _LAUNCH_CONFIG_RETRYABLE_STATUS:
                message = (
                    f"Could not fetch {runtime_label} launch config for {session_id!r}: "
                    f"GET /v1/sessions returned {resp.status_code}."
                )
                if resp.status_code >= 500 or resp.status_code in _LAUNCH_CONFIG_RETRYABLE_STATUS:
                    raise OmnigentError(
                        message,
                        category=ErrorCategory.SERVER,
                        impact=ErrorImpact.BLOCKING,
                        phase=ErrorPhase.HARNESS_SETUP,
                    )
                raise RuntimeError(message)
            _logger.warning(
                "Transient %s launch-config fetch status %d (attempt %d/%d) for "
                "session=%s; retrying",
                runtime_label,
                resp.status_code,
                attempt,
                _LAUNCH_CONFIG_FETCH_ATTEMPTS,
                session_id,
                extra={"session_id": session_id},
            )
        backoff = min(
            _LAUNCH_CONFIG_FETCH_BACKOFF_BASE_S * (2 ** (attempt - 1)),
            _LAUNCH_CONFIG_FETCH_BACKOFF_CAP_S,
        )
        await _launch_config_retry_sleep(backoff)
    assert resp is not None  # loop either broke on 200 or raised
    try:
        snapshot = resp.json()
    except ValueError as exc:
        raise OmnigentError(
            f"Could not fetch {runtime_label} launch config for {session_id!r}: invalid JSON.",
            category=ErrorCategory.SERVER,
            impact=ErrorImpact.BLOCKING,
            phase=ErrorPhase.HARNESS_SETUP,
        ) from exc
    if not isinstance(snapshot, dict):
        raise OmnigentError(
            f"Could not fetch {runtime_label} launch config for {session_id!r}: "
            "snapshot was not a JSON object.",
            category=ErrorCategory.SERVER,
            impact=ErrorImpact.BLOCKING,
            phase=ErrorPhase.HARNESS_SETUP,
        )
    return snapshot


async def _pi_native_launch_config(
    *,
    session_id: str,
    server_client: httpx.AsyncClient | None,
) -> _PiNativeLaunchConfig:
    """
    Fetch and validate a session's persisted native-terminal launch config.

    :param session_id: Session/conversation id.
    :param server_client: Runner Omnigent server client.
    :returns: Parsed launch config.
    """
    snapshot = await _fetch_native_launch_snapshot(
        server_client=server_client,
        session_id=session_id,
        runtime_label="Pi",
    )
    terminal_launch_args = snapshot.get("terminal_launch_args")
    if terminal_launch_args is not None and not (
        isinstance(terminal_launch_args, list)
        and all(isinstance(arg, str) for arg in terminal_launch_args)
    ):
        raise RuntimeError(f"Invalid terminal_launch_args for Pi session {session_id!r}.")
    external_session_id = snapshot.get("external_session_id")
    if external_session_id is not None and (
        not isinstance(external_session_id, str) or not external_session_id
    ):
        raise RuntimeError(f"Invalid external_session_id for Pi session {session_id!r}.")
    session_workspace = snapshot.get("workspace")
    if session_workspace is not None and (
        not isinstance(session_workspace, str) or not session_workspace
    ):
        raise RuntimeError(f"Invalid workspace for Pi session {session_id!r}.")
    # Fork directives stamped on a clone at fork time. Only consulted when the
    # clone has no external_session_id of its own yet (see the fork branches in
    # _auto_create_pi_terminal); inert otherwise. Mirrors the codex-native and
    # claude-native launch-config fork handling.
    from omnigent.stores.conversation_store import (
        FORK_CARRY_HISTORY_LABEL_KEY,
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
        FORK_SOURCE_LABEL_KEY,
    )

    fork_source_id: str | None = None
    fork_source_external_id: str | None = None
    fork_carry_history = False
    labels = snapshot.get("labels")
    if isinstance(labels, dict):
        _fsi = labels.get(FORK_SOURCE_LABEL_KEY)
        if isinstance(_fsi, str) and _fsi:
            fork_source_id = _fsi
        _fse = labels.get(FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY)
        if isinstance(_fse, str) and _fse:
            fork_source_external_id = _fse
        fork_carry_history = labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1"
    model_override = snapshot.get("model_override")
    if model_override is not None:
        if not isinstance(model_override, str) or not model_override:
            raise RuntimeError(f"Invalid model_override for session {session_id!r}.")
        try:
            model_override = validate_model_override(model_override)
        except ValueError as exc:
            raise RuntimeError(
                f"Invalid model_override for session {session_id!r}: {exc}"
            ) from exc
    reasoning_effort = snapshot.get("reasoning_effort")
    return _PiNativeLaunchConfig(
        workspace=_pi_session_workspace(session_workspace),
        server_url=os.environ.get("RUNNER_SERVER_URL", "http://localhost:6767").rstrip("/"),
        terminal_launch_args=terminal_launch_args,
        external_session_id=external_session_id,
        fork_source_id=fork_source_id,
        fork_source_external_id=fork_source_external_id,
        fork_carry_history=fork_carry_history,
        model_override=model_override,
        reasoning_effort=reasoning_effort
        if isinstance(reasoning_effort, str) and reasoning_effort
        else None,
        labels=labels if isinstance(labels, dict) else None,
    )


async def _codex_native_launch_config(
    *,
    session_id: str,
    server_client: httpx.AsyncClient | None,
) -> _CodexNativeLaunchConfig:
    """
    Fetch and validate persisted Codex launch config for a session.

    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param server_client: Runner Omnigent server client.
    :returns: Parsed launch config.
    :raises RuntimeError: If the session snapshot or required runner env is
        unavailable.
    """
    snapshot = await _fetch_native_launch_snapshot(
        server_client=server_client,
        session_id=session_id,
        runtime_label="Codex",
    )
    terminal_launch_args = snapshot.get("terminal_launch_args")
    if terminal_launch_args is not None and not (
        isinstance(terminal_launch_args, list)
        and all(isinstance(arg, str) for arg in terminal_launch_args)
    ):
        raise RuntimeError(f"Invalid terminal_launch_args for Codex session {session_id!r}.")
    model_override = snapshot.get("model_override")
    if model_override is not None:
        if not isinstance(model_override, str) or not model_override:
            raise RuntimeError(f"Invalid model_override for Codex session {session_id!r}.")
        # Defense-in-depth: re-validate the persisted override at the runner
        # boundary so a value that somehow bypassed server-side validation
        # can never reach the Codex ``config.toml`` / ``--model`` argv as
        # shell- or TOML-shaped input.
        try:
            validate_model_override(model_override)
        except ValueError as exc:
            raise RuntimeError(
                f"Invalid model_override for Codex session {session_id!r}: {exc}"
            ) from exc
    external_session_id = snapshot.get("external_session_id")
    if external_session_id is not None and (
        not isinstance(external_session_id, str) or not external_session_id
    ):
        raise RuntimeError(f"Invalid external_session_id for Codex session {session_id!r}.")
    from omnigent.util.reasoning_effort import CODEX_NATIVE_EFFORTS, validate_effort

    reasoning_effort = snapshot.get("reasoning_effort")
    if reasoning_effort is not None:
        try:
            reasoning_effort = validate_effort(reasoning_effort, "codex", CODEX_NATIVE_EFFORTS)
        except ValueError:
            # An effort codex cannot take must not sink the launch: keep the
            # configured default, as the per-turn override does.
            _logger.warning(
                "Ignoring unsupported reasoning_effort %r for Codex session %s",
                reasoning_effort,
                session_id,
                extra={"session_id": session_id},
            )
            reasoning_effort = None
    # The session's stored workspace is the worktree path for worktree
    # sessions (set by _create_session_worktree), or the repo root
    # otherwise. Use it as the Codex terminal cwd so worktree sessions
    # land in the worktree, matching claude-native and the Files panel.
    session_workspace = snapshot.get("workspace")
    if session_workspace is not None and (
        not isinstance(session_workspace, str) or not session_workspace
    ):
        raise RuntimeError(f"Invalid workspace for Codex session {session_id!r}.")
    # Fork directives stamped on a clone at fork time. Only consulted when
    # the clone has no external_session_id of its own yet (see the
    # fork-source branch in _auto_create_codex_terminal); inert otherwise.
    from omnigent.runner.subagent_routing import routing_class_from_snapshot
    from omnigent.stores.conversation_store import (
        CODEX_NATIVE_BYPASS_SANDBOX_LABEL_KEY,
        FORK_CARRY_HISTORY_LABEL_KEY,
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
        FORK_SOURCE_LABEL_KEY,
    )

    fork_source_id: str | None = None
    fork_source_external_id: str | None = None
    fork_carry_history = False
    _harness_override = snapshot.get("harness_override")
    _cost_control = snapshot.get("cost_control_mode_override")
    # DANGEROUS opt-in: full approval/sandbox bypass, stored as a plain
    # conversation label ("1" to enable). Read here so the runner applies
    # it at launch; any other value (incl. absent) leaves the normal stance.
    bypass_sandbox = False
    labels = snapshot.get("labels")
    if isinstance(labels, dict):
        _fsi = labels.get(FORK_SOURCE_LABEL_KEY)
        if isinstance(_fsi, str) and _fsi:
            fork_source_id = _fsi
        _fse = labels.get(FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY)
        if isinstance(_fse, str) and _fse:
            fork_source_external_id = _fse
        fork_carry_history = labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1"
        bypass_sandbox = labels.get(CODEX_NATIVE_BYPASS_SANDBOX_LABEL_KEY) == "1"
    # Best-effort model for sizing the rollover ceiling; the full provider
    # resolution runs later, in _auto_create_codex_terminal.
    model_hint = _codex_launch_model_hint(model_override, terminal_launch_args)
    compact_at_tokens = _rollover_compact_at(
        labels if isinstance(labels, dict) else None, model=model_hint
    )
    # One derivation of the session's Smart Routing class, shared with the SDK
    # codex path, so "pinned" and "auto-harness" mean the same on both.
    routing_class = routing_class_from_snapshot(
        cost_control_mode=_cost_control if isinstance(_cost_control, str) else None,
        harness_override=_harness_override if isinstance(_harness_override, str) else None,
        labels=labels if isinstance(labels, dict) else None,
    )
    return _CodexNativeLaunchConfig(
        workspace=_codex_session_workspace(session_workspace),
        policy_server_url=_required_runner_env("RUNNER_SERVER_URL"),
        terminal_launch_args=terminal_launch_args,
        model_override=model_override,
        external_session_id=external_session_id,
        fork_source_id=fork_source_id,
        fork_source_external_id=fork_source_external_id,
        fork_carry_history=fork_carry_history,
        bypass_sandbox=bypass_sandbox,
        routing_enabled=routing_class.routing_enabled,
        turn_routing=routing_class.turn_routing,
        reasoning_effort=reasoning_effort,
        compact_at_tokens=compact_at_tokens,
    )


def _pi_args_have_session_control(args: list[str]) -> bool:
    """
    Return whether user Pi args already specify session behavior.

    :param args: User pass-through Pi CLI args.
    :returns: ``True`` when Omnigent should not add resume/session flags.
    """
    session_flags = {
        "--session-dir",
        "--session",
        "--continue",
        "--resume",
        "--fork",
        "--no-session",
    }
    for arg in args:
        if arg in session_flags:
            return True
        if arg.startswith(("--session-dir=", "--session=")):
            return True
    return False


def _pi_args_have_provider(args: list[str]) -> bool:
    """Return whether user Pi args already pin a provider/model/key.

    When the user passes their own ``--provider`` / ``--model`` / ``--api-key``,
    Omnigent must not inject the ``omnigent setup`` provider on top — the
    explicit choice wins.

    :param args: User pass-through Pi CLI args.
    :returns: ``True`` when Omnigent should not add provider/model args.
    """
    provider_flags = {"--provider", "--model", "--api-key"}
    for arg in args:
        if arg in provider_flags:
            return True
        if arg.startswith(("--provider=", "--model=", "--api-key=")):
            return True
    return False


def _build_pi_native_args(
    *,
    terminal_launch_args: list[str] | None,
    extension_path: Path,
    session_dir: Path,
    external_session_id: str | None,
    approve: bool = False,
) -> list[str]:
    """
    Build Pi CLI args for a runner-owned native TUI session.

    :param terminal_launch_args: User pass-through Pi args.
    :param extension_path: Generated Omnigent Pi extension path.
    :param session_dir: Per-Omnigent-session Pi session directory.
    :param external_session_id: Captured Pi session id, if any.
    :param approve: When ``True``, pass ``--approve`` to pre-accept Pi's
        project-folder trust dialog (supported from Pi 0.79+).
    :returns: Complete Pi arg vector excluding the executable.
    """
    user_args = list(terminal_launch_args or [])
    args = ["--extension", str(extension_path)]
    if approve:
        # Pre-accept the project-folder trust dialog. Pi 0.79+ shows a
        # blocking TUI prompt on first launch in a directory with .pi/
        # resources. In a web-UI-driven session there is nobody at the
        # terminal to answer it — mirroring ensure_claude_workspace_trusted.
        args.append("--approve")
    if not _pi_args_have_session_control(user_args):
        args.extend(["--session-dir", str(session_dir)])
        if external_session_id:
            args.extend(["--session", external_session_id])
    args.extend(user_args)
    return args


async def _resolve_pi_resume_session(
    *,
    session_id: str,
    launch_config: _PiNativeLaunchConfig,
    session_dir: Path,
    workspace: Path,
    server_client: httpx.AsyncClient | None,
) -> str | None:
    """
    Ensure Pi has a local session JSONL and return the id to launch with.

    Three cases, mirroring claude-native / codex-native fork+resume:

    1. **Cold resume** — the session already carries a captured Pi
       ``external_session_id`` but the local session file may be missing
       (cross-machine, a fresh runner, or a cleared bridge dir). Synthesize the
       file from committed Omnigent items so ``pi --session <id>`` opens with
       prior context. An existing file is reused untouched.
    2. **Fork rebuild** — a forked clone bound to a pi-native target with NO
       captured session of its own and a carry-history marker: mint a new Pi
       session id, build its file from the clone's OWN copied Omnigent items,
       and patch the server so Omnigent reflects the clone's session id and a
       later relaunch resumes it via case 1.
    3. **Fresh / nothing to carry** — return ``None`` so Pi launches a brand
       new session.

    Best-effort: on any failure we return the (possibly ``None``) captured id
    so Pi launches fresh rather than pointing ``--session`` at a file that does
    not exist.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param launch_config: Resolved Pi launch config (carries the captured id
        and fork directives).
    :param session_dir: Directory passed to ``pi --session-dir``.
    :param workspace: Resolved cwd Pi will run in.
    :param server_client: Runner Omnigent server client.
    :returns: Pi session id to launch with via ``--session``, or ``None`` to
        launch fresh.
    """
    if server_client is None:
        return launch_config.external_session_id
    if launch_config.external_session_id is None and not launch_config.fork_carry_history:
        return None

    from omnigent.harnesses.pi_native.resume import (
        ensure_local_pi_resume_session,
        mint_pi_session_id,
    )

    # Resolve the provider's model only for the synthesized assistant records'
    # informational ``model`` field; Pi's resume uses the live provider, so a
    # missing model is harmless.
    model = ""
    try:
        from omnigent.harnesses.pi_native.credentials import resolve_pi_native_provider

        provider = await asyncio.to_thread(resolve_pi_native_provider)
        if provider is not None and getattr(provider, "model", None):
            model = provider.model
    except Exception:  # noqa: BLE001 — informational only; never block launch
        model = ""

    # Case 1: cold resume of a session that already has a captured Pi id.
    if launch_config.external_session_id is not None:
        built: Path | None = None
        try:
            built = await ensure_local_pi_resume_session(
                server_client,
                session_id=session_id,
                external_session_id=launch_config.external_session_id,
                session_dir=session_dir,
                workspace=workspace,
                model=model,
            )
        except Exception:
            built = None
            _logger.warning(
                "Could not synthesize Pi resume session for %s; launching fresh",
                session_id,
                exc_info=True,
                extra={"session_id": session_id},
            )
        # Only launch with ``--session <id>`` when a session file actually
        # exists/was written. ``ensure_local_pi_resume_session`` returns
        # ``None`` when nothing resumable was produced (missing/cleared bridge
        # dir, empty history, or a transient fetch/write failure caught above).
        # Returning the captured id regardless would emit ``pi --session <id>``
        # for a file that does not exist — Pi then exits instead of launching,
        # defeating the best-effort fallback this function promises. Fall back
        # to a fresh session (return ``None``) in that case.
        if built is None:
            _logger.info(
                "Pi cold-resume produced no local session file for %s; launching fresh",
                session_id,
                extra={"session_id": session_id},
            )
            return None
        return launch_config.external_session_id

    # Case 2: forked clone bound to a pi-native target with no captured session
    # yet. Build the clone's session from its OWN copied Omnigent items under a
    # minted id. (A same-provider source's captured id, when present, is stamped
    # as fork_source_external_id; but Pi session files are runner-local and the
    # clone has its OWN copied items, so we rebuild from items either way —
    # there is no cross-session "resume the source's file" like codex's clone.)
    if launch_config.fork_carry_history:
        minted = mint_pi_session_id()
        try:
            built = await ensure_local_pi_resume_session(
                server_client,
                session_id=session_id,
                external_session_id=minted,
                session_dir=session_dir,
                workspace=workspace,
                model=model,
            )
        except Exception:
            built = None
            _logger.warning(
                "Could not build Pi session from items for forked clone %s; launching fresh",
                session_id,
                exc_info=True,
                extra={"session_id": session_id},
            )
        _logger.info(
            "Pi terminal fork-rebuild decision: session=%s minted=%s built=%s",
            session_id,
            minted,
            str(built) if built is not None else None,
            extra={"session_id": session_id},
        )
        if built is not None:
            # Record the minted id so Omnigent reflects the clone's own Pi
            # session and a later relaunch resumes it via case 1. Best-effort:
            # the extension also re-captures the id on session_start, so a
            # failed patch is recovered then.
            try:
                await server_client.patch(
                    f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                    json={"external_session_id": minted},
                    params={"include_usage": "false"},
                    timeout=10.0,
                )
            except httpx.HTTPError:
                _logger.warning(
                    "Could not pre-set external_session_id for forked Pi clone %s; "
                    "relying on extension capture",
                    session_id,
                    exc_info=True,
                    extra={"session_id": session_id},
                )
            return minted

    return None


async def _auto_create_pi_terminal(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    server_client: httpx.AsyncClient | None,
    agent_spec: AgentSpec | ResolvedSpec | None = None,
    ensure_comment_relay: _EnsureCommentRelay | None = None,
) -> SessionResourceView:
    """
    Auto-create a Pi terminal for a pi-native session.

    :param session_id: Session/conversation identifier.
    :param resource_registry: Session resource registry for launching the
        terminal.
    :param publish_event: Runner session event publisher.
    :param server_client: Runner Omnigent server client.
    :param agent_spec: The session's resolved agent spec, passed so the Pi
        terminal inherits the agent's ``os_env.sandbox`` rather than falling
        back to the platform default. ``None`` only when the session has no
        spec; callers must not pass ``None`` to paper over a resolution error.
    :returns: Created terminal resource view.
    """
    await _cancel_auto_forwarder_task(session_id)
    from omnigent.conversation_browser import conversation_url
    from omnigent.harnesses.pi_native.bridge import (
        PI_NATIVE_CONFIG_ENV_VAR,
        clear_inbox,
        pi_native_env_unset,
        pi_session_dir,
        prepare_bridge_dir,
        set_rollover_threshold_tokens,
        write_extension_files,
    )
    from omnigent.harnesses.pi_native.bridge import extension_path as pi_extension_path
    from omnigent.harnesses.pi_native.main import resolve_pi_executable
    from omnigent.inner.datamodel import OSEnvSpec, TerminalEnvSpec
    from omnigent.runner._entry import _make_auth_token_factory

    launch_config = await _pi_native_launch_config(
        session_id=session_id,
        server_client=server_client,
    )
    workspace = str(launch_config.workspace)
    bridge_dir = prepare_bridge_dir(session_id)
    # Drop stale payloads so a relaunched Pi process can't replay them.
    clear_inbox(bridge_dir)
    pi_extension = pi_extension_path(bridge_dir)
    session_dir = pi_session_dir(bridge_dir)
    auth_factory = _make_auth_token_factory()
    auth_token = await asyncio.to_thread(auth_factory) if auth_factory is not None else None
    # Route the extension's out-of-process POSTs (/events, /mcp,
    # /policies/evaluate) through the shared header builder so they carry the
    # workspace / deployment routing selectors, not just a bare bearer. A bare
    # bearer skips those selectors and can land on a different server instance
    # than the one the runner (and the web UI) are on, so live-streamed items
    # never reach the browser's in-process event stream (they only appear on reload).
    from omnigent.cli_auth import databricks_request_headers

    auth_headers = databricks_request_headers(launch_config.server_url, bearer_token=auth_token)
    # A guest-on-shared-host runner authenticates the extension's out-of-process
    # posts with the tunnel binding token, not a Databricks bearer; the per-turn
    # refresh runs env-scrubbed and can only preserve this header, so bake it in
    # here at launch (harmless additive header on bearer-authenticated servers).
    from omnigent.runner._entry import _runner_tunnel_binding_token_from_env
    from omnigent.runner.identity import RUNNER_TUNNEL_TOKEN_HEADER

    binding_token = _runner_tunnel_binding_token_from_env()
    if binding_token:
        auth_headers[RUNNER_TUNNEL_TOKEN_HEADER] = binding_token
    # Build the Omnigent tool surface (sys_* tools) the Pi extension registers
    # via pi.registerTool. Reuses the same schema set the claude-native /
    # codex-native relay advertises, gated by the session's spec. Each tool's
    # execute() round-trips through POST /v1/sessions/{id}/mcp, so the Pi agent
    # can call Omnigent tools with centralized server-side policy enforcement
    # — parity with the other native harnesses. Best-effort: a schema-build
    # failure must not block the terminal launch, so fall back to no tools.
    pi_tools: list[_JsonObject] = []
    try:
        from omnigent.runner.tool_dispatch import build_native_relay_tool_schemas

        spec_for_tools = _unwrap_resolved_spec(agent_spec)
        pi_tools = build_native_relay_tool_schemas(spec_for_tools, labels=launch_config.labels)
    except Exception:
        _logger.warning(
            "Failed to build pi-native tool schemas for session %s; "
            "Pi will run with its built-in tools only",
            session_id,
            exc_info=True,
        )
    _extension, config = write_extension_files(
        bridge_dir,
        session_id=session_id,
        server_url=launch_config.server_url,
        conversation_url=conversation_url(launch_config.server_url, session_id),
        auth_headers=auth_headers,
        tools=pi_tools,
        labels=launch_config.labels,
    )
    pi_command = resolve_pi_executable()
    # Rebuild the local Pi session JSONL from committed Omnigent items so a
    # cold-resume or fork opens with prior conversation context (parity with
    # claude-native / codex-native). Returns the id to launch with via
    # ``--session`` (the captured id, a minted fork id, or None for fresh).
    resume_session_id = await _resolve_pi_resume_session(
        session_id=session_id,
        launch_config=launch_config,
        session_dir=session_dir,
        workspace=launch_config.workspace,
        server_client=server_client,
    )
    from omnigent.harnesses.pi_native.main import pi_supports_approve

    pi_args = _build_pi_native_args(
        terminal_launch_args=launch_config.terminal_launch_args,
        extension_path=pi_extension,
        session_dir=session_dir,
        external_session_id=resume_session_id,
        approve=await asyncio.to_thread(pi_supports_approve, pi_command),
    )
    from omnigent.context.labels import is_rollover
    from omnigent.runtime.prompt import ROLLOVER_NATIVE_INSTRUCTIONS

    if is_rollover(launch_config.labels):
        pi_args.extend(["--append-system-prompt", ROLLOVER_NATIVE_INSTRUCTIONS])
    pi_env = {
        PI_NATIVE_CONFIG_ENV_VAR: str(config),
        "OMNIGENT_PI_NATIVE_BRIDGE_DIR": str(bridge_dir),
    }
    # Route the runner-owned Pi process through the provider configured by
    # ``omnigent setup`` (Databricks gateway / API key), so a separate
    # ``pi /login`` isn't required — the parity codex-native/claude-native
    # already have. Skipped when the user pinned their own provider/model via
    # terminal_launch_args. When no usable provider is configured Pi falls
    # back to its own login, but a spec/session-pinned model still passes
    # through as ``--model``. Writes a managed per-session Pi config dir,
    # never touching the user's global ``~/.pi/agent``.
    credential_warning: str | None = None
    effort_notice: str | None = None
    from omnigent.inference_config import binding_for_harness, load_runtime_inference_config

    pi_binding = binding_for_harness(load_runtime_inference_config(), "pi-native")
    if pi_binding is not None and _pi_args_have_provider(launch_config.terminal_launch_args or []):
        raise ValueError(
            "This session has a configured Pi provider. Select its model in the composer "
            "and remove --provider, --model, and --api-key from terminal arguments."
        )
    if not _pi_args_have_provider(launch_config.terminal_launch_args or []):
        from omnigent.harnesses.pi_native.credentials import (
            pi_native_provider_launch,
            pi_own_login_model_arg,
            resolve_pi_native_provider,
        )

        # Provider-qualified picker values select one of the models rendered
        # from the provider configured through ``omni setup``.
        spec_model = launch_config.model_override or _pi_native_model_from_spec(agent_spec)
        pi_spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
        # Provider discovery does network I/O; keep the runner's stream and
        # tunnel heartbeats responsive while Pi starts.
        if pi_binding is not None and pi_spec is not None:
            provider = await asyncio.to_thread(
                resolve_pi_native_provider, model=spec_model, auth=pi_spec.executor.auth
            )
        else:
            provider = await asyncio.to_thread(resolve_pi_native_provider, model=spec_model)
        if provider is not None:
            launch = pi_native_provider_launch(
                bridge_dir / "pi-agent",
                provider,
                launch_config.reasoning_effort,
                selection=spec_model,
                labels=launch_config.labels,
            )
            pi_env.update(launch.env)
            pi_args.extend(launch.args)
            # The extension config was written before the model's window was
            # known; patch in the threshold Pi's own settings use.
            if launch.rollover_threshold_tokens is not None:
                set_rollover_threshold_tokens(bridge_dir, launch.rollover_threshold_tokens)
            # An unroutable model leaves Pi unable to select it, which looks
            # like a silent hang; prefer that notice over the credential one
            # since it names the model the user actually picked.
            credential_warning = provider.unroutable_model_warning() or provider.credential_warning
            # An ignored effort setting is informational — the session still
            # works, so it posts as a neutral notice rather than an error banner.
            effort_notice = launch.effort_warning if not credential_warning else None
        elif spec_model:
            # No managed provider: Pi runs on its own login, but the pinned
            # model must still reach it — without this the pick is silently
            # dropped and Pi opens its own default model. A managed pick that
            # cannot be expressed for Pi's own resolver (slash-bearing model
            # id) is refused rather than mis-routed, so Pi keeps its default.
            own_login_model = pi_own_login_model_arg(spec_model)
            if own_login_model is not None:
                pi_args.extend(["--model", own_login_model])
    # Inherit the agent's os_env so its sandbox (e.g. ``type: none``),
    # egress_rules and env_passthrough are honoured. Without ``sandbox`` here
    # and ``parent_os_env`` below, launch_required_terminal falls back to
    # _default_sandbox_for_platform (linux_bwrap), overriding the YAML config.
    agent_os_env = _agent_os_env_from_spec(agent_spec)
    terminal_view = await resource_registry.launch_required_terminal(
        session_id=session_id,
        terminal_name="pi",
        session_key="main",
        resource_role=PI_NATIVE_TERMINAL_ROLE,
        parent_os_env=agent_os_env,
        spec=TerminalEnvSpec(
            os_env=OSEnvSpec(
                type="caller_process",
                cwd=workspace,
                sandbox=(agent_os_env.sandbox if agent_os_env is not None else None),
            ),
            command=pi_command,
            args=pi_args,
            env=pi_env,
            # Credential vars the operator declared off-limits for Pi
            # (OMNIGENT_PI_ENV_UNSET): Pi activates a built-in provider's
            # whole catalog on the mere presence of its credential, flooding
            # the picker with entries that bypass the managed models.json
            # provider — and Pi needs no credential env (its auth rides the
            # managed apiKey). Empty list = no scrubbing.
            env_unset=pi_native_env_unset(os.environ),
            scrollback=100_000,
            tmux_allow_passthrough=True,
            tmux_start_on_attach=False,
            # Keep the private tmux server alive if the `pi` CLI exits. Without
            # this, tmux (exit-empty on, remain-on-exit off) reaps the lone-pane
            # server the instant pi exits, the idle watcher's probes fail with
            # "tmux unavailable", and the exit is undiagnosable. With it, the
            # dead pane persists (last output capturable) and the watcher
            # reports the exit deterministically via `#{pane_dead}` — parity
            # with the claude terminal.
            keep_alive_after_exit=True,
        ),
    )
    publish_event(
        session_id,
        {
            "type": "session.resource.created",
            "resource": session_resource_view_to_dict(terminal_view),
        },
    )
    _logger.info(
        "Auto-created pi terminal for session %s with extension %s",
        session_id,
        pi_extension,
    )

    if server_client is not None and ensure_comment_relay is not None:
        await ensure_comment_relay(
            session_id,
            explicit_bridge_dir=bridge_dir,
            await_notify=False,
        )
        from omnigent.harnesses.claude_native.bridge import _TOOL_RELAY_FILE, _read_json_file
        from omnigent.harnesses.pi_native.bridge import inject_relay_into_config

        relay_info = _read_json_file(bridge_dir / _TOOL_RELAY_FILE)
        relay_url = relay_info.get("url") if relay_info else None
        relay_token = relay_info.get("token") if relay_info else None
        if isinstance(relay_url, str) and isinstance(relay_token, str):
            inject_relay_into_config(bridge_dir, relay_url, relay_token)

    # Surface an unresolved-credential warning to the session. Without it, a Pi
    # session whose Databricks token can't be refreshed launches fine but every
    # message silently fails to reach the model — the user sees no reply and no
    # reason. Best-effort: a delivery failure must not fail the launch.
    if credential_warning is not None:
        await _post_pi_native_credential_warning(
            session_id=session_id,
            server_client=server_client,
            warning=credential_warning,
        )
    if effort_notice is not None:
        await _post_pi_native_effort_notice(
            session_id=session_id,
            server_client=server_client,
            notice=effort_notice,
        )
    return terminal_view


async def _post_pi_native_credential_warning(
    *,
    session_id: str,
    server_client: httpx.AsyncClient | None,
    warning: str,
) -> None:
    """Surface a credential warning into the session as an error banner.

    Posts an ``error`` item via ``external_conversation_item`` so the notice
    renders as the web UI's distinct destructive banner (not a misleading
    assistant bubble), persists across reload, and — because ``error`` is a
    non-content item type — never enters the next turn's model context. The
    event persists without queuing an agent turn, so it's safe on a session
    whose model is unreachable.

    :param session_id: Session/conversation identifier.
    :param server_client: Runner Omnigent server client (``None`` in tests).
    :param warning: The user-facing warning text to surface.
    """
    if server_client is None:
        return
    try:
        resp = await server_client.post(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}/events",
            json={
                "type": "external_conversation_item",
                "data": {
                    "item_type": "error",
                    "item_data": {
                        "source": "execution",
                        "code": "pi_credentials_unresolved",
                        "message": warning,
                    },
                },
            },
            timeout=30.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError:
        _logger.warning(
            "pi-native: failed to surface credential warning for session %s",
            session_id,
            exc_info=True,
        )


async def _post_pi_native_effort_notice(
    *,
    session_id: str,
    server_client: httpx.AsyncClient | None,
    notice: str,
) -> None:
    """Surface an ignored effort setting as a neutral info notice.

    Posts an ``error`` item with ``level: "info"`` so the web UI renders a
    neutral notice pill rather than a destructive banner. The session still
    works; the effort setting was silently dropped because the gateway-routed
    model does not support thinking.

    :param session_id: Session/conversation identifier.
    :param server_client: Runner Omnigent server client (``None`` in tests).
    :param notice: The user-facing notice text to surface.
    """
    if server_client is None:
        return
    try:
        resp = await server_client.post(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}/events",
            json={
                "type": "external_conversation_item",
                "data": {
                    "item_type": "error",
                    "item_data": {
                        "source": "execution",
                        "code": "pi_native_effort_ignored",
                        "message": notice,
                        "level": "info",
                    },
                },
            },
            timeout=30.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError:
        _logger.warning(
            "pi-native: failed to surface effort notice for session %s",
            session_id,
            exc_info=True,
        )


_CODEX_THREAD_RESET_NOTICE = (
    "Codex reported an internal error while loading this session's saved transcript, "
    "so Omnigent started a fresh Codex thread instead of failing the turn. The chat "
    "history here is intact, but Codex's own memory of the earlier turns is not "
    "restored."
)


async def _post_codex_thread_reset_notice(
    *,
    session_id: str,
    server_client: httpx.AsyncClient | None,
    codex_error: str,
) -> None:
    """Surface a codex fresh-thread fallback into the session as a notice.

    Posts an ``error`` item with ``level: "info"`` via
    ``external_conversation_item`` so the web UI renders a neutral notice pill
    at the point the thread was reset, persists it across reload, and — because
    ``error`` is a non-content item type — keeps it out of the next turn's
    model context. The body quotes codex's own error so the cause is clearly
    codex-side. Best-effort: a failed post only loses the notice.

    :param session_id: Session/conversation identifier.
    :param server_client: Runner Omnigent server client (``None`` in tests).
    :param codex_error: The error text codex returned for ``thread/resume``,
        e.g. ``"failed to read thread: thread-store internal error: …"``.
    """
    if server_client is None:
        return
    try:
        resp = await server_client.post(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}/events",
            json={
                "type": "external_conversation_item",
                "data": {
                    "item_type": "error",
                    "item_data": {
                        "source": "harness",
                        "code": "codex_thread_reset",
                        "message": (
                            f"{_CODEX_THREAD_RESET_NOTICE}\n\nCodex reported: {codex_error}"
                        ),
                        "level": "info",
                    },
                },
            },
            timeout=30.0,
        )
        resp.raise_for_status()
    except httpx.HTTPError:
        _logger.warning(
            "codex-native: failed to surface the fresh-thread notice for session %s",
            session_id,
            exc_info=True,
        )


class _CodexNativeTuiLaunch(NamedTuple):
    view: SessionResourceView
    terminal_instance: TerminalInstance | None
    thread_start_timeout_seconds: float | None


def _codex_exit_watch_decision(
    *,
    terminal_registry_present: bool,
    instance: TerminalInstance | None,
    launched_socket: object,
) -> tuple[TerminalInstance | None, str | None]:
    """Decide whether an instance may arm discovery's terminal-exit fast-fail.

    Returns ``(instance, None)`` when the instance is trustworthy, else
    ``(None, reason)``. Only a *definitive* socket mismatch discards a live
    instance: the launched socket disagreeing with a known registry socket.
    A missing/unknown launched socket must not disarm — the earlier guard
    compared ``str(instance.socket_path)`` against a bare
    ``metadata.get("tmux_socket")`` and would have discarded a healthy
    instance whenever that key was absent (``str(path) != None`` is always
    true). The normal launch path projects the socket via
    :func:`terminal_resource_view`, so that key is present in practice; this
    is defensive hardening against any launch path that omits it, paired with
    a ``codex_startup_exit_watch_unarmed`` event so a disarmed launch is
    observable rather than surfacing only as a thread-start timeout. A
    registry miss (no instance) or an absent registry also leaves fast-fail
    unarmed, each with its own reason code.
    """
    if not terminal_registry_present:
        return None, "no_terminal_registry"
    if instance is None:
        return None, "registry_miss"
    if launched_socket is not None and str(instance.socket_path) != str(launched_socket):
        return None, "socket_mismatch"
    return instance, None


async def _launch_codex_native_tui(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    app_server: CodexNativeAppServer,
    launch_config: _CodexNativeLaunchConfig,
    bridge_dir: Path,
    thread_id: str | None,
    agent_spec: AgentSpec | ResolvedSpec | None,
    login_required: bool = False,
) -> _CodexNativeTuiLaunch:
    """Attach a terminal to an app-server without owning its lifecycle."""
    from omnigent.harnesses.codex_native.app_server import (
        _MIN_BYPASS_HOOK_TRUST_CODEX_VERSION,
        _format_codex_version,
        build_codex_remote_args,
        codex_terminal_env,
    )
    from omnigent.harnesses.codex_native.bridge import (
        CODEX_NATIVE_CONFIGURED_COMMAND_STARTUP_TIMEOUT_SECONDS,
        codex_terminal_interactive,
    )
    from omnigent.harnesses.codex_native.launch_args import redact_codex_launch_args
    from omnigent.inner.datamodel import OSEnvSpec, TerminalEnvSpec

    codex_ws_url = app_server.listen_url
    assert codex_ws_url is not None
    workspace = str(launch_config.workspace)
    agent_os_env = _agent_os_env_from_spec(agent_spec)
    codex_remote_args = build_codex_remote_args(
        codex_args=tuple(launch_config.terminal_launch_args or ()),
        thread_id=thread_id,
        remote_url=codex_ws_url,
        bypass_sandbox=launch_config.bypass_sandbox,
        # The remote TUI needs the app-server's provider and cannot answer an update prompt.
        config_overrides=(
            *app_server.config_overrides,
            "check_for_update_on_startup=false",
        ),
        codex_cli_version=app_server.codex_cli_version,
        # The runner provisions and trusts these hooks. An unknown CLI version
        # must not strand a headless session behind an interactive trust prompt.
        bypass_hook_trust=(
            app_server.codex_cli_version is None
            or app_server.codex_cli_version >= _MIN_BYPASS_HOOK_TRUST_CODEX_VERSION
        ),
    )
    # Apply configured wrappers to both cold start and recovery.
    from omnigent.config import load_effective_config
    from omnigent.harness_startup_config import (
        resolve_harness_args,
        resolve_harness_config,
    )

    _codex_harness_cfg = load_effective_config()
    # Honor configured wrappers while keeping the host-provisioned binary
    # immune to ambient OMNIGENT_CODEX_PATH overrides.
    _, _codex_overrides = resolve_harness_config(_codex_harness_cfg)
    _codex_cmd_override = (_codex_overrides.get("codex-native") or {}).get("command")
    configured_codex_command = (
        _codex_cmd_override.strip()
        if isinstance(_codex_cmd_override, str) and _codex_cmd_override.strip()
        else None
    )
    codex_command = configured_codex_command or app_server.codex_path
    thread_start_timeout_seconds = (
        CODEX_NATIVE_CONFIGURED_COMMAND_STARTUP_TIMEOUT_SECONDS
        if configured_codex_command is not None and not login_required
        else None
    )
    if configured_codex_command is not None:
        if thread_id is not None:
            _logger.info(
                "Codex resume: bridge state is preloaded before configured "
                "command %r starts; no bridge-state wait extension is needed "
                "(session %s)",
                configured_codex_command,
                session_id,
            )
        elif login_required:
            _logger.info(
                "Codex startup: configured command %r requires interactive "
                "login; preserving the unbounded sign-in wait (session %s)",
                configured_codex_command,
                session_id,
            )
        elif thread_start_timeout_seconds is not None:
            _logger.info(
                "Codex startup: configured command %r gets a %.0fs "
                "thread-start budget (session %s)",
                configured_codex_command,
                thread_start_timeout_seconds,
                session_id,
            )
    codex_launch_args = resolve_harness_args(
        "codex-native", tuple(codex_remote_args), cfg=_codex_harness_cfg
    )
    loggable_launch_args = shlex.join(redact_codex_launch_args(codex_launch_args))
    _logger.info(
        "Codex terminal launch: session=%s command=%s codex_cli_version=%s resume=%s args=%s",
        session_id,
        codex_command,
        _format_codex_version(app_server.codex_cli_version),
        thread_id is not None,
        loggable_launch_args,
        extra=debug_event(
            "codex_terminal_launch",
            session_id=session_id,
            command=codex_command,
            codex_cli_version=_format_codex_version(app_server.codex_cli_version),
            resume=thread_id is not None,
            args=loggable_launch_args,
        ),
    )
    terminal_view = await resource_registry.launch_auxiliary_terminal(
        session_id=session_id,
        terminal_name="codex",
        session_key="main",
        resource_role=CODEX_NATIVE_TERMINAL_ROLE,
        parent_os_env=agent_os_env,
        spec=TerminalEnvSpec(
            os_env=OSEnvSpec(
                type="caller_process",
                cwd=workspace,
                sandbox=(agent_os_env.sandbox if agent_os_env is not None else None),
            ),
            command=codex_command,
            args=codex_launch_args,
            env=codex_terminal_env(app_server),
            # Match the local ``omnigent codex`` terminal scrollback.
            scrollback=100_000,
            # Preserve the final frame and exit status until lifecycle cleanup.
            keep_alive_after_exit=True,
            # Enable tmux passthrough so the Codex TUI's escape sequences
            # reach the web xterm.
            tmux_allow_passthrough=True,
            # Let the initial render settle detached so attaching over the
            # runner tunnel does not starve its heartbeat with startup traffic.
            tmux_start_on_attach=False,
        ),
    )
    terminal_registry = getattr(resource_registry, "terminal_registry", None)
    registry_instance = (
        terminal_registry.get(session_id, "codex", "main")
        if terminal_registry is not None
        else None
    )
    # ``terminal_instance`` arms discovery's exit-detection race
    # (:func:`_wait_for_codex_thread_or_terminal_exit`), which fails a launch
    # the instant its TUI exits instead of waiting out the full thread-start
    # budget.
    terminal_instance, exit_watch_unarmed_reason = _codex_exit_watch_decision(
        terminal_registry_present=terminal_registry is not None,
        instance=registry_instance,
        launched_socket=terminal_view.metadata.get("tmux_socket"),
    )
    if exit_watch_unarmed_reason is not None:
        _logger.warning(
            "Codex startup exit-detection unarmed (%s) for session %s; a TUI that "
            "exits before creating a thread will surface only at the thread-start "
            "timeout, not immediately",
            exit_watch_unarmed_reason,
            session_id,
            extra=debug_event(
                "codex_startup_exit_watch_unarmed",
                session_id=session_id,
                harness="codex-native",
                reason=exit_watch_unarmed_reason,
            ),
        )
    publish_event(
        session_id,
        {
            "type": "session.resource.created",
            "resource": session_resource_view_to_dict(terminal_view),
        },
    )
    _schedule_terminal_interactive_observer(
        session_id=session_id,
        resource_registry=resource_registry,
        terminal_name="codex",
        session_key="main",
        harness="codex-native",
        readiness_signal="codex_composer",
        is_interactive=lambda pane: codex_terminal_interactive(bridge_dir, pane),
    )
    return _CodexNativeTuiLaunch(terminal_view, terminal_instance, thread_start_timeout_seconds)


async def _auto_create_codex_terminal(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    bundle_dir: Path | None = None,
    skills_filter: str | list[str] = "all",
    agent_spec: AgentSpec | ResolvedSpec | None = None,
    server_client: httpx.AsyncClient | None = None,
    ensure_comment_relay: _EnsureCommentRelay | None = None,
) -> SessionResourceView:
    """
    Auto-create a Codex terminal for a codex-native session.

    Called when the runner receives a codex-native session via
    ``POST /v1/sessions`` or an explicit terminal ensure request and no
    terminal exists yet. Mirrors :func:`_auto_create_claude_terminal`: it
    boots a Codex app-server, registers the Codex TUI as a streamable
    terminal resource attached to that app-server, then runs the transcript
    forwarder so the chat and terminal share one thread. An exited TUI
    reuses its live app-server and forwarder.

    Fresh sessions launch without a thread id so the TUI owns thread
    creation; resume sessions launch with the persisted Codex thread id,
    falling back to a fresh thread when Codex cannot read that thread's
    rollout (see :func:`is_unreadable_thread_error`). The runner does not
    pre-create a thread, because ``codex resume`` of a thread with no
    rollout yet exits the TUI (leaving a dead pane).

    :param session_id: Session/conversation identifier, e.g.
        ``"conv_abc123"``.
    :param resource_registry: Session resource registry used to launch
        the Codex terminal resource.
    :param publish_event: The runner's per-session SSE emitter, used to
        surface the new terminal on the live stream (the Omnigent relay
        republishes it to the web UI) so the Terminal toggle enables
        without a refresh.
    :param bundle_dir: Materialized agent-bundle root when the session's
        agent ships a ``skills/`` directory, resolved by the caller
        (which has the runner's spec resolver). Its skills are linked
        into the per-bridge ``$CODEX_HOME/skills/`` before the
        app-server boots so the native Codex discovers them — matching
        the wrapped ``codex`` executor. ``None`` exposes no bundle skills.
    :param skills_filter: The agent spec's ``skills_filter`` (``"all"``
        / ``"none"`` / list of skill names), honoured when populating
        ``$CODEX_HOME/skills/``. Defaults to ``"all"``.
    :param agent_spec: Optional resolved agent spec for the session.
        When provided, its executor model is used as the Codex app-server
        default, e.g. ``"gpt-5.4-mini"``.
    :param server_client: Runner's Omnigent server HTTP client. Used to read
        persisted launch args and the native thread id.
    :returns: The created terminal resource view.
    """
    import socket as _socket
    from pathlib import Path

    from omnigent.harnesses.codex_native.app_server import (
        CodexAppServerClient,
        CodexAppServerResponseError,
        apply_codex_thread_effort,
        build_codex_native_server,
        codex_remote_resume_omits_permission_args,
        codex_session_meta_model_provider,
        fresh_codex_launch_catalog,
        is_unreadable_thread_error,
        preload_codex_thread_for_resume,
        resolve_native_codex_launch,
    )
    from omnigent.harnesses.codex_native.bridge import (
        CodexNativeBridgeState,
        clear_bridge_state,
        codex_home_for_bridge_dir,
        prepare_bridge_dir,
        read_bridge_state,
        socket_path_for_bridge_dir,
        write_bridge_startup_timeout,
        write_bridge_state,
    )
    from omnigent.inner.codex_executor import codex_extended_catalog_env

    launch_config = await _codex_native_launch_config(
        session_id=session_id,
        server_client=server_client,
    )
    original_external_session_id = launch_config.external_session_id
    workspace = str(launch_config.workspace)
    bridge_dir = prepare_bridge_dir(session_id)
    socket_path = socket_path_for_bridge_dir(bridge_dir)
    codex_home = codex_home_for_bridge_dir(bridge_dir)
    app_server = _AUTO_CODEX_APP_SERVERS.get(session_id)
    forwarder = _AUTO_FORWARDER_TASKS.get(session_id)
    bridge_state = read_bridge_state(bridge_dir)
    process = getattr(app_server, "proc", None)
    if (
        app_server is not None
        and process is not None
        and process.returncode is None
        and forwarder is not None
        and not forwarder.done()
        and bridge_state is not None
        and bridge_state.thread_id == launch_config.external_session_id
        and bridge_state.socket_path == app_server.listen_url
        and bridge_state.codex_home == str(app_server.codex_home)
    ):
        # The TUI is auxiliary: replacing it must not restart an active turn,
        # reinitialize MCP, or cancel transcript forwarding.
        _logger.info(
            "Recreating Codex terminal on existing app-server for session=%s",
            session_id,
            extra={"session_id": session_id},
        )
        launched = await _launch_codex_native_tui(
            session_id,
            resource_registry,
            publish_event,
            app_server=app_server,
            launch_config=launch_config,
            bridge_dir=bridge_dir,
            thread_id=bridge_state.thread_id,
            agent_spec=agent_spec,
        )
        return launched.view
    # Route across all offerings: a configured provider (omnigent setup),
    # a Databricks ucode profile from provider config, or Codex's own
    # login — parity with the in-process codex harness and the CLI path.
    # Resolved before the fork/cold-resume branches below so any rollout
    # synthesis can stamp session_meta.model_provider with the provider
    # this launch actually routes through.
    unpinned_model = _codex_native_model_from_spec(agent_spec)
    default_model = launch_config.model_override or unpinned_model
    # Thread the spec so its executor.auth / legacy profile win over
    # machine-level config, parity with the in-process harness (#2744).
    _launch_spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    _codex_launch = resolve_native_codex_launch(model=default_model, spec=_launch_spec)
    from omnigent.inference_config import binding_for_harness, load_runtime_inference_config

    codex_binding = binding_for_harness(load_runtime_inference_config(), "codex-native")
    from omnigent.inner.codex_executor import _find_codex_cli

    _codex_cli_path = _find_codex_cli()
    _catalog_launch = None
    _fresh_codex_catalog: list[_JsonObject] | None = None
    try:
        _catalog_launch = await asyncio.to_thread(
            resolve_native_codex_launch, model=None, spec=_launch_spec
        )
        _fresh_codex_catalog = fresh_codex_launch_catalog(
            codex_path=_codex_cli_path,
            launch=_catalog_launch,
        )
    except Exception:
        _logger.debug(
            "fresh codex launch catalog unavailable for session=%s",
            session_id,
            exc_info=True,
            extra={"session_id": session_id},
        )
    pick_to_reset: str | None = None
    # Explicit launches (model-flows design §4): validate an explicit request
    # against the shared catalog, and give a Default launch on codex's own
    # login the ACCOUNT's real default — so the ``model =`` line copied from
    # the user's shared config can never govern a session (the stale-gpt-5.4
    # 400 class). Profile-backed shapes already resolve their default at
    # materialization time and are left alone.
    if codex_binding is None and (
        launch_config.model_override
        or (_codex_launch.model is None and _codex_launch.profile is None)
    ):
        from omnigent.harnesses.codex_native.app_server import (
            codex_launch_catalog,
            codex_launch_catalog_is_stale,
            codex_reprobed_launch_catalog,
        )
        from omnigent.models.codex_model_vocabulary import codex_reachable_model_slug
        from omnigent.models.model_catalog_store import default_row

        _codex_catalog: list[_JsonObject] | None = None
        _codex_catalog_was_stale = False
        try:
            if _catalog_launch is None:
                _catalog_launch = await asyncio.to_thread(
                    resolve_native_codex_launch, model=None, spec=_launch_spec
                )
            # Read staleness before the fetch can start a background probe.
            # The fingerprint and probe must use this session's provider.
            _codex_catalog_was_stale = await codex_launch_catalog_is_stale(
                codex_path=_codex_cli_path, launch=_catalog_launch
            )
            _codex_catalog = await codex_launch_catalog(
                codex_path=_codex_cli_path, launch=_catalog_launch
            )
        except Exception:
            _logger.warning(
                "codex launch catalog unavailable for session=%s",
                session_id,
                exc_info=True,
                extra={"session_id": session_id},
            )
        if launch_config.model_override and _codex_catalog:
            pick = launch_config.model_override
            reachable = codex_reachable_model_slug(pick, _codex_catalog)
            fresh_rows = _codex_catalog
            if reachable is None and _codex_catalog_was_stale:
                fresh_rows = await codex_reprobed_launch_catalog(
                    codex_path=_codex_cli_path, launch=_catalog_launch
                )
                if fresh_rows:
                    _codex_catalog = fresh_rows
                    _codex_catalog_was_stale = False
                    reachable = codex_reachable_model_slug(pick, fresh_rows)
            if reachable is None:
                # Re-resolve so provider overrides cannot retain the old model.
                # A failed probe permits fallback, but cannot retire the pick.
                _codex_launch = resolve_native_codex_launch(
                    model=unpinned_model, spec=_launch_spec
                )
                pick_to_reset = pick if fresh_rows else None
                outcome = (
                    "resetting the pick to Default after terminal launch"
                    if pick_to_reset is not None
                    else "keeping the pick because the catalog re-probe failed"
                )
                offered = ", ".join(
                    str(row.get("id") or row.get("model") or "") for row in _codex_catalog
                )
                _logger.warning(
                    "codex-native: model pick %r for session %s is not in the provider's "
                    "model list (it offers: %s); launching on the default and %s",
                    pick,
                    session_id,
                    offered,
                    outcome,
                    extra={"session_id": session_id},
                )
        if _codex_launch.model is None and _codex_launch.profile is None and _codex_catalog:
            # Same staleness rule as the claude branch: never convert a stale
            # entry's default into an explicit model pin.
            if _codex_catalog_was_stale:
                _logger.info(
                    "codex catalog for session=%s is stale; deferring the Default "
                    "launch to codex's own default model",
                    session_id,
                )
            else:
                _catalog_default = default_row(_codex_catalog)
                _default_id = (
                    str(_catalog_default.get("id") or _catalog_default.get("model") or "") or None
                    if _catalog_default is not None
                    else None
                )
                if _default_id:
                    _codex_launch = dataclasses.replace(_codex_launch, model=_default_id)
        if _codex_catalog and not _codex_catalog_was_stale:
            _fresh_codex_catalog = _codex_catalog
    _session_meta_provider = codex_session_meta_model_provider(_codex_launch)
    # Cancel any surviving forwarder first so its teardown closes the OLD app-server,
    # not the one registered below — and so it can't mirror alongside the new one.
    await _cancel_auto_forwarder_task(session_id)
    clear_bridge_state(bridge_dir)
    # Only a resume can conflict with a stale writer for the same Codex thread.
    # Fresh sessions have no thread writer to recover and must not pay for a
    # machine-wide ``ps`` scan on their terminal-interactivity path.
    if launch_config.external_session_id is not None:
        from omnigent.harnesses.codex_native.process_registry import (
            reap_codex_native_processes_for_state_dir,
        )

        session_reap_started_at = time.monotonic()
        session_reaped_processes = await asyncio.to_thread(
            reap_codex_native_processes_for_state_dir,
            bridge_dir,
        )
        session_reap_elapsed_ms = int((time.monotonic() - session_reap_started_at) * 1000)
        _logger.info(
            "Codex same-session stale-process cleanup completed: "
            "session=%s elapsed_ms=%d reaped_processes=%s",
            session_id,
            session_reap_elapsed_ms,
            session_reaped_processes,
            extra=debug_event(
                "codex_session_stale_process_cleanup",
                session_id=session_id,
                elapsed_ms=session_reap_elapsed_ms,
                reaped_processes=session_reaped_processes,
            ),
        )

    # Forked clone with no native thread of its own yet: clone the SOURCE's
    # local Codex rollout into the clone's OWN CODEX_HOME under a thread id
    # we mint (rewriting session_meta.id + the structural cwd fields), then
    # flip launch_config so the normal resume path below launches
    # ``codex resume <our_thread_id>``. The app-server boots from this
    # CODEX_HOME just below, so the rollout must be written first. Only
    # viable when the source rollout exists on THIS host (same-host fork —
    # CUJ 1 same-user); otherwise the item-history fallback below runs. This
    # mirrors the claude-native fork-resume branch in
    # _auto_create_claude_terminal. See designs/FORK_SESSION_UX.md.
    if (
        launch_config.external_session_id is None
        and launch_config.fork_source_external_id is not None
        and launch_config.fork_source_id is not None
    ):
        from omnigent.harnesses.codex_native.main import (
            _clone_codex_rollout,
            _mint_codex_thread_id,
        )

        target_thread_id = _mint_codex_thread_id()
        clone_workspace = Path(workspace).resolve()
        try:
            cloned_rollout = _clone_codex_rollout(
                source_session_id=launch_config.fork_source_id,
                source_thread_id=launch_config.fork_source_external_id,
                target_thread_id=target_thread_id,
                clone_codex_home=codex_home,
                clone_workspace=clone_workspace,
            )
        except Exception:
            cloned_rollout = None
            _logger.warning(
                "Could not clone source rollout for forked codex clone %s; "
                "trying item-history fallback",
                session_id,
                exc_info=True,
            )
        _logger.info(
            "Codex terminal fork-resume decision: session=%s source_id=%s source_ext=%s "
            "our_thread=%s clone_workspace=%s cloned_rollout=%s",
            session_id,
            launch_config.fork_source_id,
            launch_config.fork_source_external_id,
            target_thread_id,
            clone_workspace,
            str(cloned_rollout) if cloned_rollout is not None else None,
            extra={"session_id": session_id},
        )
        if cloned_rollout is not None:
            # Resume our OWN clone via the existing resume path below.
            launch_config = dataclasses.replace(
                launch_config, external_session_id=target_thread_id
            )
            # Record the assigned thread id now so Omnigent reflects the clone's
            # own Codex thread immediately and a later relaunch resumes it.
            # Best-effort, like the claude-native fork branch.
            if server_client is not None:
                try:
                    await server_client.patch(
                        f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                        json={"external_session_id": target_thread_id},
                        params={"include_usage": "false"},
                        timeout=10.0,
                    )
                except httpx.HTTPError:
                    # The clone resumes via the known-thread forwarder (no
                    # discovery), so nothing re-captures the id later: it stays
                    # unset on the Omnigent session and a future relaunch of this
                    # clone will start fresh rather than resume the cloned
                    # rollout. The cloned rollout itself is already on disk, so
                    # the current launch still resumes with history.
                    _logger.warning(
                        "Could not pre-set external_session_id for forked codex clone %s; "
                        "it will remain unset and a future relaunch will start fresh",
                        session_id,
                        exc_info=True,
                    )
    if (
        launch_config.external_session_id is None
        and launch_config.fork_carry_history
        and server_client is not None
    ):
        # Forked clone bound to a codex-native target with no source rollout
        # available: build the clone's rollout from its own copied Omnigent
        # items under a thread id we mint, then flip launch_config so the
        # resume path below launches ``codex resume <our_thread_id>``. Reuses
        # the same server-items→rollout converter the cross-machine cold resume
        # uses, so the clone opens with the prior conversation as Codex context.
        # Best-effort: launch fresh on failure. See designs/FORK_SESSION_UX.md.
        from omnigent.harnesses.codex_native.main import (
            _ensure_local_codex_resume_rollout,
            _mint_codex_thread_id,
        )

        target_thread_id = _mint_codex_thread_id()
        clone_workspace = Path(workspace).resolve()
        try:
            built_rollout = await _ensure_local_codex_resume_rollout(
                server_client,
                session_id=session_id,
                external_session_id=target_thread_id,
                codex_home=codex_home,
                workspace=clone_workspace,
                model_provider=_session_meta_provider,
                codex_path=_codex_cli_path,
                terminal_launch_args=launch_config.terminal_launch_args,
            )
        except Exception:
            built_rollout = None
            _logger.warning(
                "Could not build rollout from items for forked codex clone %s; launching fresh",
                session_id,
                exc_info=True,
            )
        _logger.info(
            "Codex terminal fork-rebuild decision: session=%s our_thread=%s "
            "clone_workspace=%s built_rollout=%s",
            session_id,
            target_thread_id,
            clone_workspace,
            str(built_rollout) if built_rollout is not None else None,
            extra={"session_id": session_id},
        )
        if built_rollout is not None:
            launch_config = dataclasses.replace(
                launch_config, external_session_id=target_thread_id
            )
            try:
                await server_client.patch(
                    f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                    json={"external_session_id": target_thread_id},
                    params={"include_usage": "false"},
                    timeout=10.0,
                )
            except httpx.HTTPError:
                _logger.warning(
                    "Could not pre-set external_session_id for forked codex clone %s; "
                    "it will remain unset and a future relaunch will start fresh",
                    session_id,
                    exc_info=True,
                )

    if launch_config.external_session_id is not None and original_external_session_id is not None:
        from omnigent.harnesses.codex_native.main import _ensure_local_codex_resume_rollout

        if server_client is None:
            raise RuntimeError("server_client is required for Codex cold resume.")
        await _ensure_local_codex_resume_rollout(
            server_client,
            session_id=session_id,
            external_session_id=launch_config.external_session_id,
            codex_home=codex_home,
            workspace=Path(workspace).resolve(),
            model_provider=_session_meta_provider,
            codex_path=_codex_cli_path,
            terminal_launch_args=launch_config.terminal_launch_args,
        )
    # Link the bundle's skills into the per-bridge CODEX_HOME before the
    # app-server boots — Codex discovers ``$CODEX_HOME/skills/<name>/``
    # at startup. This is the codex-native mirror of the wrapped codex
    # executor's skill population; the native CLI otherwise sees zero
    # bundled skills. Best-effort: a skill-link failure must not break
    # the terminal launch.
    from omnigent.inner.codex_executor import (
        _codex_home_config_source_from_env,
        populate_codex_skills_from_bundle,
    )

    try:
        # Native Codex honors $CODEX_HOME; seed skills from that resolved home
        # (not a hardcoded ~/.codex) so the terminal and the web menu list the
        # same host skills.
        populate_codex_skills_from_bundle(
            codex_home,
            bundle_dir,
            skills_filter,
            source_codex_home=_codex_home_config_source_from_env(),
        )
    except OSError:
        _logger.warning(
            "Could not populate codex skills for %s; native Codex will see no bundled skills",
            session_id,
            exc_info=True,
        )

    with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        codex_ws_port = s.getsockname()[1]
    codex_ws_url = f"ws://127.0.0.1:{codex_ws_port}"

    # Write the minimal MCP bridge config so serve-mcp can boot, and
    # start the tool relay so tool_relay.json is on disk before codex
    # launches its MCP server. This mirrors the claude-native relay
    # start in ``create_session_terminal``. The relay is started here
    # (not in ``_ensure_comment_relay_started``) because that helper
    # is scoped inside ``create_routes`` and not reachable at module
    # level. The ``_run_turn_bg`` fallback path covers sessions whose
    # terminal was created outside this function.
    from omnigent.harnesses.codex_native.bridge import (
        codex_mcp_config_overrides,
        write_mcp_bridge_config,
    )
    from omnigent.harnesses.codex_native.launch_args import codex_rollover_config_overrides

    write_mcp_bridge_config(bridge_dir)
    mcp_overrides = codex_mcp_config_overrides(bridge_dir)
    rollover_overrides = (
        codex_rollover_config_overrides(launch_config.compact_at_tokens)
        if launch_config.compact_at_tokens is not None
        else []
    )

    # Omnigent coordinates for the codex-native policy hook. The hook runs as a
    # separate subprocess that POSTs tool calls to /policies/evaluate, so
    # it reads a one-shot token snapshot from policy_hook.json — same as
    # the claude-native PermissionRequest hook on this host-spawned path.
    from omnigent.runner._entry import _make_auth_token_factory

    _policy_auth_factory = _make_auth_token_factory()
    _policy_auth_token = _policy_auth_factory() if _policy_auth_factory is not None else None
    # The codex policy hook subprocess replays these static headers from its
    # config (no refresh-capable auth of its own); the helper pairs the bearer
    # with the workspace-routing header so neither is dropped.
    from omnigent.cli_auth import databricks_request_headers

    policy_headers = databricks_request_headers(
        launch_config.policy_server_url, bearer_token=_policy_auth_token
    )

    from omnigent.runtime.prompt import ROLLOVER_NATIVE_INSTRUCTIONS

    _codex_developer_instructions = (
        "\n\n".join(
            x
            for x in [
                _native_startup_raw_instructions_from_spec(agent_spec),
                ROLLOVER_NATIVE_INSTRUCTIONS if launch_config.compact_at_tokens else None,
            ]
            if x
        )
        or None
    )
    # SDK initialization can block on DNS/auth before model discovery times out.
    # Keep it off the runner loop so heartbeats and other sessions can progress.
    app_server = await asyncio.to_thread(
        build_codex_native_server,
        session_id=session_id,
        socket_path=socket_path,
        codex_home=codex_home,
        cwd=Path(workspace),
        model=_codex_launch.model,
        profile=_codex_launch.profile,
        extra_config_overrides=[
            *_codex_launch.config_overrides,
            *mcp_overrides,
            *rollover_overrides,
        ],
        bridge_dir=bridge_dir,
        ap_server_url=launch_config.policy_server_url,
        ap_auth_headers=policy_headers,
        bypass_sandbox=launch_config.bypass_sandbox,
        developer_instructions=_codex_developer_instructions,
        terminal_launch_args=launch_config.terminal_launch_args or (),
        reasoning_effort=launch_config.reasoning_effort,
        model_catalog_rows=_fresh_codex_catalog,
        # Codex can show project-trust and legacy-model migration prompts before
        # creating a thread. This TUI runs detached for the web UI, so persist
        # the runner-owned acknowledgements in the private session config.
        trust_project=True,
        # Codex ignores --dangerously-bypass-hook-trust for the startup
        # hook-review screen on a persistent ``resume`` attach, which strands a
        # resumed web session behind the interactive "Hooks need review" prompt.
        # Persist trust for every merged hook so the review finds nothing to
        # review. See trust_all_codex_hooks.
        trust_all_hooks=True,
        # The host-global background janitor reconciles crash-leftover
        # app-servers. A targeted same-session reap remains synchronous only
        # for the resume path where an old writer can block correctness.
        reconcile_process_registry=False,
    )
    # A routed turn can land on an arm codex's bundled catalog has no entry for
    # (GLM), which its own client-side validation then refuses — so a Smart
    # Routing session (pinned or auto) gets the extended catalog. A plain
    # session keeps codex's bundled catalog and never pays the probe.
    app_server.env.update(codex_extended_catalog_env(launch_config.routing_enabled))
    # First-message model routing. Advertised in the same bridge dir the
    # ``UserPromptSubmit`` hook is pointed at (so the hook needs no env of
    # its own), and live before the app-server starts because the hook can
    # fire on the very first prompt.
    _codex_turn_router = _start_turn_router_for_native_session(
        session_id,
        bridge_dir=bridge_dir,
        harness="codex-native",
        server_client=server_client,
        turn_routing=launch_config.turn_routing,
    )
    app_server.listen_url = codex_ws_url
    await app_server.start()
    _AUTO_CODEX_APP_SERVERS[session_id] = app_server

    event_client = CodexAppServerClient(
        ws_url=codex_ws_url,
        client_name="omnigent-codex-native-auto",
    )
    retained_resume_client: CodexAppServerClient | None = None
    if launch_config.external_session_id is not None:
        try:
            retained_resume_client = await preload_codex_thread_for_resume(
                codex_ws_url,
                launch_config.external_session_id,
                terminal_launch_args=launch_config.terminal_launch_args,
                cwd=Path(workspace),
                retain_client=codex_remote_resume_omits_permission_args(
                    app_server.codex_cli_version
                ),
            )
            if retained_resume_client is not None:
                event_client = retained_resume_client
        except BaseException as exc:
            if not isinstance(exc, Exception) or not is_unreadable_thread_error(exc):
                # The app-server started above must not outlive a refused resume:
                # without this close, every retry stacked another live codex
                # process (and only the newest stayed tracked for teardown).
                with contextlib.suppress(Exception):
                    await app_server.close()
                _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
                raise
            # Codex cannot load this thread's rollout, so no retry can resume
            # it. Start a fresh thread on the same app-server instead of
            # failing every turn; the discovery path records the new id.
            _logger.warning(
                "Codex cannot read thread %s for session %s; starting a fresh "
                "thread (earlier Codex-side context is not restored): %s",
                launch_config.external_session_id,
                session_id,
                exc,
                extra={"session_id": session_id},
            )
            codex_error = (
                exc.message
                if isinstance(exc, CodexAppServerResponseError) and exc.message
                else str(exc)
            )
            await _post_codex_thread_reset_notice(
                session_id=session_id, server_client=server_client, codex_error=codex_error
            )
            launch_config = dataclasses.replace(launch_config, external_session_id=None)
    if launch_config.external_session_id is None:
        try:
            # Connect the listener BEFORE launching the TUI so it observes the
            # ``thread/started`` the TUI emits on startup (the client buffers
            # notifications, so there is no created-before-listening race).
            await event_client.connect()
        except BaseException:
            # connect() may have half-opened the ws before the initialize
            # handshake failed, so close the listener too — not just the
            # app-server.
            with contextlib.suppress(Exception):
                await event_client.close()
            await app_server.close()
            _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
            raise

    # Register the Codex TUI as a streamable terminal resource attached to
    # the app-server started above (``--remote`` over its loopback ws
    # endpoint). Without this the session can have a working chat path
    # (driven by the forwarder) but no terminal to attach to, unlike
    # claude-native, whose terminal IS the agent process. On failure, close
    # the listener and app-server here: the background forwarder task (which
    # otherwise owns their teardown) has not been created yet.
    # Inherit the agent's os_env so its sandbox (e.g. ``type: none``),
    # egress_rules and env_passthrough are honoured. Without ``sandbox`` here
    # and ``parent_os_env`` below, launch_terminal falls back to
    # _default_sandbox_for_platform (linux_bwrap), overriding the YAML config.
    # Fresh sessions pass no thread id so the TUI creates the thread and the
    # background task adopts it. Resume sessions pass the persisted
    # external_session_id so the runner-owned TUI reopens the existing
    # app-server thread.
    # The app-server and event client are live by this point, so the pre-launch
    # setup (arg build + config resolve) shares the terminal launch's teardown
    # below: a raise here must still close them and drop the
    # ``_AUTO_CODEX_APP_SERVERS`` entry, or the failure leaks the app-server.
    try:
        if launch_config.external_session_id is not None:
            write_bridge_state(
                bridge_dir,
                CodexNativeBridgeState(
                    session_id=session_id,
                    socket_path=codex_ws_url,
                    thread_id=launch_config.external_session_id,
                    codex_home=str(codex_home),
                    # The session workspace: without it the executor falls back
                    # to the runner process's own cwd when starting turns.
                    cwd=workspace,
                ),
            )
            if launch_config.reasoning_effort:
                # A resumed thread runs the rollout's effort, not the config pin.
                try:
                    await apply_codex_thread_effort(
                        codex_ws_url,
                        launch_config.external_session_id,
                        launch_config.reasoning_effort,
                        model=_codex_launch.model,
                    )
                except Exception:
                    _logger.warning(
                        "codex-native: could not apply reasoning effort %r to resumed thread "
                        "%s for session %s; the next web turn re-applies it",
                        launch_config.reasoning_effort,
                        launch_config.external_session_id,
                        session_id,
                        exc_info=True,
                        extra={"session_id": session_id},
                    )
        launched = await _launch_codex_native_tui(
            session_id,
            resource_registry,
            publish_event,
            app_server=app_server,
            launch_config=launch_config,
            bridge_dir=bridge_dir,
            thread_id=launch_config.external_session_id,
            agent_spec=agent_spec,
            login_required=_codex_launch.login_required,
        )
        terminal_view = launched.view
        terminal_instance = launched.terminal_instance
        thread_start_timeout_seconds = launched.thread_start_timeout_seconds
    except BaseException:
        with contextlib.suppress(Exception):
            await event_client.close()
        with contextlib.suppress(Exception):
            await app_server.close()
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
        raise

    # Known-thread resumes publish bridge state before the terminal starts;
    # only fresh discovery needs to extend the executor's state wait.
    if launch_config.external_session_id is None and thread_start_timeout_seconds is not None:
        try:
            write_bridge_startup_timeout(bridge_dir, thread_start_timeout_seconds)
        except OSError:
            # The marker only extends the executor's legacy wait. A write
            # failure must not strand the terminal before its forwarder owns
            # it, and the forwarder must not keep waiting past the executor's
            # legacy deadline that the marker can no longer extend: fall both
            # sides back to the legacy timeout so the forwarder's precise
            # startup error lands while the executor is still reporting.
            thread_start_timeout_seconds = None
            _logger.warning(
                "Could not publish Codex startup timeout for session %s; "
                "falling back to the legacy startup timeout for the executor "
                "and the forwarder",
                session_id,
                exc_info=True,
            )

    # Adopt the thread the fresh TUI creates and run the forwarder in the
    # background, so session creation never blocks on TUI startup.
    _forwarder_task = asyncio.create_task(
        (
            _codex_discover_thread_and_forward(
                session_id=session_id,
                bridge_dir=bridge_dir,
                codex_ws_url=codex_ws_url,
                codex_home=codex_home,
                workspace=workspace,
                event_client=event_client,
                app_server=app_server,
                terminal_instance=terminal_instance,
                routing_summary=_codex_launch.summary,
                login_required=_codex_launch.login_required,
                thread_start_timeout_seconds=thread_start_timeout_seconds,
                turn_router=_codex_turn_router,
            )
            if launch_config.external_session_id is None
            else _codex_forward_known_thread(
                session_id=session_id,
                bridge_dir=bridge_dir,
                codex_ws_url=codex_ws_url,
                thread_id=launch_config.external_session_id,
                client=retained_resume_client,
                turn_router=_codex_turn_router,
            )
        ),
        name=f"codex-forwarder-{session_id}",
    )
    _register_auto_forwarder_task(session_id, _forwarder_task)

    if pick_to_reset is not None and server_client is not None:
        await _clear_session_model_override(
            session_id,
            server_client,
            expected_model_override=pick_to_reset,
        )

    # A prompt a previous launch blocked for routing but never got to replay
    # exists nowhere else: the block consumed it and the marker stops the hook
    # from ever asking again. Drain it once this launch's thread is live.
    _recover_pending_turn_replay(
        session_id,
        bridge_dir=bridge_dir,
        server_client=server_client,
    )

    # Start the relay now (into codex's serve-mcp bridge dir) so tool_relay.json
    # is on disk and the relay recorded before codex connects on its first turn:
    # the first-turn `_ensure_comment_relay_started` then fast-paths, avoiding
    # the ~30s stall (see its docstring for the lazy-bridge / await_notify=False
    # rationale).
    if ensure_comment_relay is not None:
        await ensure_comment_relay(session_id, explicit_bridge_dir=bridge_dir, await_notify=False)

    _logger.info(
        "Auto-created codex terminal + forwarder for session %s",
        session_id,
    )
    return terminal_view


def _codex_terminal_exit_summary(instance: TerminalInstance, *, before_thread: bool) -> str:
    """Describe a TUI startup exit without inventing an unavailable status."""
    exit_status = instance.last_exit_status()
    status_text = f" with status {exit_status}" if exit_status is not None else ""
    stage = "before starting a thread" if before_thread else "before becoming available"
    return f"Codex terminal exited{status_text} {stage}."


def _codex_startup_terminal_output(instance: TerminalInstance) -> str | None:
    """Apply the same capture gate and bounds to both startup-error paths."""
    from omnigent.harnesses.diagnostics import sanitize_diagnostic_text
    from omnigent.process_logging import harness_stderr_capture_enabled
    from omnigent.runner.resource_registry import trim_terminal_output

    if not harness_stderr_capture_enabled():
        return None
    return trim_terminal_output(sanitize_diagnostic_text(instance.last_exit_text() or ""))


class _CodexTerminalExited(RuntimeError):
    """The exact TUI stopped before its thread could be discovered."""

    def __init__(self, instance: TerminalInstance) -> None:
        self.instance = instance
        super().__init__(_codex_terminal_exit_summary(instance, before_thread=True))


class _CodexSignInPromptSeen(RuntimeError):
    """The live pane shows a stable launcher sign-in prompt before any thread started."""

    def __init__(self, instance: TerminalInstance) -> None:
        self.instance = instance
        super().__init__("Codex pane is parked on a sign-in prompt")


async def _codex_pane_screen(instance: TerminalInstance) -> str:
    """Return the pane's screen with wrapped rows joined, or ``""`` when it cannot be read."""
    try:
        # A sign-in address is far wider than the 80-column pane the runner
        # creates, so read wrapped rows joined back into their original lines.
        result = await instance.read(join_wrapped=True)
    except Exception:
        _logger.debug(
            "Codex startup pane read failed for %s", instance.diagnostic_id, exc_info=True
        )
        return ""
    raw_screen = result.get("screen") if isinstance(result, dict) else None
    return raw_screen if isinstance(raw_screen, str) else ""


async def _wait_for_codex_thread_or_terminal_exit(
    thread_started: Awaitable[str],
    instance: TerminalInstance,
    *,
    poll_interval_s: float = _TERMINAL_INTERACTIVE_POLL_INTERVAL_S,
    watch_sign_in: bool = False,
) -> str:
    """
    Stop startup discovery promptly without following a replacement terminal.

    With *watch_sign_in* the pane is also read every
    ``_CODEX_SIGN_IN_POLL_INTERVAL_S`` for a launcher sign-in prompt; the same
    address on two consecutive reads raises :class:`_CodexSignInPromptSeen` so
    the caller can record it well before the thread-start budget expires.
    """
    from omnigent.harnesses.diagnostics import detect_sign_in_prompt

    async def wait_for_exit() -> None:
        while await instance.is_alive():
            await asyncio.sleep(poll_interval_s)

    async def wait_for_sign_in_prompt() -> None:
        previous_url: str | None = None
        while True:
            await asyncio.sleep(_CODEX_SIGN_IN_POLL_INTERVAL_S)
            prompt = detect_sign_in_prompt(await _codex_pane_screen(instance))
            if prompt is not None and prompt.url == previous_url:
                return
            previous_url = prompt.url if prompt is not None else None

    thread_task = asyncio.ensure_future(thread_started)
    exit_task = asyncio.create_task(wait_for_exit())
    sign_in_task = asyncio.create_task(wait_for_sign_in_prompt()) if watch_sign_in else None
    tasks: list[asyncio.Future[Any]] = [thread_task, exit_task]
    if sign_in_task is not None:
        tasks.append(sign_in_task)
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        # A discovered thread remains usable through the app-server after TUI exit.
        if thread_task in done:
            return await thread_task
        if sign_in_task is not None and sign_in_task in done:
            await sign_in_task
            raise _CodexSignInPromptSeen(instance)
        # Propagate probe failures instead of reporting a normal terminal exit.
        await exit_task
        # Let an already-queued notification reach the discovery waiter.
        await asyncio.sleep(0)
        if thread_task.done():
            return await thread_task
        raise _CodexTerminalExited(instance)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _record_agent_startup_pending(
    *,
    session_id: str,
    bridge_dir: Path,
    terminal_instance: TerminalInstance,
    routing_summary: str,
    waited_seconds: float,
) -> None:
    """
    Record that Codex is still starting behind a live pane, noting a sign-in prompt it shows.

    A launcher wrapper can park the pane on a sign-in prompt. The wait records
    this as soon as the prompt is stable on screen, or at the thread-start
    budget when the pane shows something else. Chat turns read the record and
    fail fast with the next step instead of the generic "thread never
    started"; the discovery wait then continues without a deadline and clears
    the record once the thread starts.

    :param session_id: Omnigent session/conversation id.
    :param bridge_dir: Native Codex bridge directory for this session.
    :param terminal_instance: The live TUI pane, read once for its screen text.
    :param routing_summary: One-line description of the resolved launch routing.
    :param waited_seconds: How long discovery has waited for the thread so far.
    """
    from omnigent.harnesses.codex_native.bridge import write_bridge_startup_error
    from omnigent.harnesses.diagnostics import detect_sign_in_prompt, sign_in_next_step

    prompt = detect_sign_in_prompt(await _codex_pane_screen(terminal_instance))
    if prompt is not None:
        code = "databricks_sign_in_pending"
        title = "Codex can't start until you sign in to Databricks"
        message = "Codex is waiting for a sign-in in this session's terminal."
        remediation = sign_in_next_step("Codex")
    else:
        code = "agent_startup_pending"
        title = "Codex is still starting"
        message = (
            "Codex is still starting in this session's terminal and may be waiting "
            "for a sign-in there."
        )
        remediation = (
            "Finish any sign-in shown in the session terminal, then send your message again."
        )
    write_bridge_startup_error(
        bridge_dir,
        f"{message} Launch routing: {routing_summary}.",
        code=code,
        title=title,
        remediation=remediation,
    )
    pending_event = debug_event("agent_startup_pending", session_id=session_id)
    pending_event["attributes"] = {
        "harness": "codex-native",
        "phase": "thread_discovery",
        "waited_s": round(waited_seconds, 1),
        "sign_in_prompt_detected": prompt is not None,
        "code": code,
    }
    _logger.warning(
        "Codex TUI for %s has not started a thread after %.0fs but its pane is alive; "
        "recorded %s and waiting without a deadline%s",
        session_id,
        waited_seconds,
        code,
        " (a sign-in prompt is on screen)" if prompt is not None else "",
        extra=pending_event,
    )


async def _codex_discover_thread_and_forward(
    *,
    session_id: str,
    bridge_dir: Path,
    codex_ws_url: str,
    codex_home: Path,
    workspace: str,
    event_client: CodexAppServerClient,
    routing_summary: str,
    app_server: CodexNativeAppServer | None = None,
    terminal_instance: TerminalInstance | None = None,
    login_required: bool = False,
    thread_start_timeout_seconds: float | None = None,
    turn_router: TurnRouter | None = None,
) -> None:
    """
    Adopt the fresh Codex TUI's thread, then mirror it into the Omnigent session.

    Runs as a background task spawned by :func:`_auto_create_codex_terminal`
    so session creation never blocks on TUI startup. Waits for the fresh TUI
    to create its app-server thread, persists the bridge state (so the Codex
    executor's bridge-state retry can inject web-UI turns into that same
    thread), then runs the transcript forwarder for the session's lifetime.

    :param session_id: Omnigent session/conversation id, e.g. ``"conv_abc123"``.
    :param bridge_dir: Native Codex bridge directory for this session.
    :param codex_ws_url: App-server loopback ws URL the TUI and forwarder
        attach to, e.g. ``"ws://127.0.0.1:9876"``. Persisted as the bridge
        state's ``socket_path`` (the executor reads it to reach the
        app-server) and re-persisted by the forwarder's thread-rotation
        path so a native ``/clear`` keeps the ws:// transport.
    :param codex_home: Per-session private ``CODEX_HOME`` path.
    :param workspace: The session workspace directory, persisted as the
        bridge state's ``cwd`` so web-driven turns run shell tools there
        instead of the runner process's working directory.
    :param event_client: Connected app-server listener that will observe the
        TUI's ``thread/started``; reused to subscribe the forwarder.
    :param routing_summary: One-line description of the resolved launch
        routing (provider / profile / model, or the login-fallback state),
        threaded into the startup-timeout error so hosted users can diagnose
        without runner-log access (see #2745).
    :param app_server: This launch's process, retained for failure diagnostics
        before cleanup. A later launch may replace the session registry entry.
    :param terminal_instance: This launch's TUI, retained to detect early exit
        without depending on thread creation or a later registry lookup.
    :param login_required: ``True`` when the resolved launch defers to
        Codex's own login with no usable stored credential — the TUI parks
        on the sign-in screen and cannot start a thread on its own. Chat
        turns then fail fast with an actionable error (instead of burning
        the thread-start timeout), while thread discovery keeps listening
        so an interactive sign-in from the terminal still recovers the
        session.
    :param thread_start_timeout_seconds: Configured-command thread-start
        allowance. ``None`` preserves the forwarder's ordinary 30-second
        default. While *terminal_instance* is running, a stable sign-in
        prompt on its screen, or the budget expiring, records a pending
        cause (see :func:`_record_agent_startup_pending`) and the wait
        continues without a deadline; only a pane exit or an ended event
        stream tears down.
    :param turn_router: First-message routing endpoint this launch
        started, torn down in the ``finally``.
    """
    from omnigent.harnesses.codex_native.bridge import (
        CODEX_NATIVE_DIRECT_THREAD_START_TIMEOUT_SECONDS,
        CodexNativeBridgeState,
        clear_bridge_startup_error,
        write_bridge_startup_error,
        write_bridge_state,
    )
    from omnigent.harnesses.codex_native.diagnostics import collect_codex_startup_diagnostics
    from omnigent.harnesses.codex_native.forwarder import (
        supervise_forwarder,
        wait_for_thread_started,
    )
    from omnigent.runner._entry import (
        _make_auth_token_factory,
        _RunnerDatabricksAuth,
    )

    if login_required:
        # The launch router already knows this TUI can only render the
        # sign-in screen: no provider routes the codex harness and Codex
        # itself holds no usable stored login. Record the cause up front so
        # a chat turn (headless sub-agent dispatch, web message) fails
        # immediately with an actionable error instead of hanging through
        # the thread-start timeout, then keep listening without a deadline
        # — a user signing in from the attached terminal still starts the
        # thread, at which point the pre-recorded error is cleared below.
        _logger.warning(
            "Codex launch for %s has no usable credential (%s); chat turns will "
            "fail fast until a sign-in or provider routes the launch",
            session_id,
            routing_summary,
        )
        write_bridge_startup_error(
            bridge_dir,
            "Codex is not signed in and no Omnigent provider routes the codex "
            "harness, so the Codex TUI is parked on its sign-in screen and "
            f"cannot run this turn. Launch routing: {routing_summary}. "
            "Sign in from the session terminal, or configure a provider "
            "(`omnigent setup`), then send the message again.",
        )

    discovery_started_at = time.monotonic()
    startup_pending_recorded = False
    try:
        while True:
            try:
                if login_required or startup_pending_recorded:
                    # No deadline: the turn-facing cause is already recorded,
                    # so this wait only serves a possible interactive sign-in.
                    thread_started = wait_for_thread_started(event_client, timeout=None)
                elif thread_start_timeout_seconds is not None:
                    thread_started = wait_for_thread_started(
                        event_client,
                        timeout=thread_start_timeout_seconds,
                    )
                else:
                    thread_started = wait_for_thread_started(event_client)
                thread_id = (
                    await thread_started
                    if terminal_instance is None
                    else await _wait_for_codex_thread_or_terminal_exit(
                        thread_started,
                        terminal_instance,
                        poll_interval_s=(
                            _CODEX_LOGIN_EXIT_POLL_INTERVAL_S
                            if login_required or startup_pending_recorded
                            else _TERMINAL_INTERACTIVE_POLL_INTERVAL_S
                        ),
                        # Once the cause is recorded there is nothing more to
                        # learn from the pane until the thread starts.
                        watch_sign_in=not (login_required or startup_pending_recorded),
                    )
                )
                break
            except (TimeoutError, RuntimeError) as exc:
                if (
                    terminal_instance is not None
                    and not startup_pending_recorded
                    and (
                        isinstance(exc, _CodexSignInPromptSeen)
                        or (isinstance(exc, TimeoutError) and await terminal_instance.is_alive())
                    )
                ):
                    # The pane is still running: parked on a launcher sign-in
                    # prompt, or slow past its budget. Record why chat turns
                    # cannot run yet and keep listening; a pane exit still ends
                    # discovery below.
                    await _record_agent_startup_pending(
                        session_id=session_id,
                        bridge_dir=bridge_dir,
                        terminal_instance=terminal_instance,
                        routing_summary=routing_summary,
                        waited_seconds=time.monotonic() - discovery_started_at,
                    )
                    startup_pending_recorded = True
                    continue
                # Expected failure modes of wait_for_thread_started: the TUI exited
                # at startup, or the event stream ended before a thread was
                # created. Stop forwarding (cleanup runs in ``finally``); any other
                # error is a bug and propagates.
                try:
                    diagnostics = collect_codex_startup_diagnostics(app_server)
                    # Capture the TUI's own exit status/output, not just the
                    # app-server's stderr (which stays healthy while the client
                    # dies). On a terminal-exited failure this is the raised
                    # instance; on a timeout/event-stream failure the TUI may have
                    # exited without the discovery wait catching it (an unwatched
                    # instance, or a pane kept alive by remain-on-exit), so fall
                    # back to this launch's instance and refresh its liveness so
                    # ``#{pane_dead_status}`` and the final frame are recorded.
                    diag_instance = (
                        exc.instance
                        if isinstance(exc, _CodexTerminalExited)
                        else terminal_instance
                    )
                    if diag_instance is not None:
                        from omnigent.process_logging import harness_stderr_capture_enabled

                        if not isinstance(exc, _CodexTerminalExited):
                            with contextlib.suppress(Exception):
                                await diag_instance.is_alive()
                        terminal_exit_status = diag_instance.last_exit_status()
                        diagnostics.update(
                            terminal_instance_id=diag_instance.diagnostic_id,
                            terminal_exit_status=terminal_exit_status,
                            # A non-``_CodexTerminalExited`` failure whose TUI has a
                            # recorded exit status means the client died but the
                            # wait timed out anyway; distinguish it from a TUI that
                            # is alive-but-never-ready (status ``None``).
                            terminal_exited_undetected=(
                                not isinstance(exc, _CodexTerminalExited)
                                and terminal_exit_status is not None
                            ),
                        )
                        if harness_stderr_capture_enabled():
                            diagnostics["terminal_last_output"] = _codex_startup_terminal_output(
                                diag_instance
                            )
                except Exception as diagnostics_error:  # noqa: BLE001
                    # Diagnostics must not replace the startup error or prevent cleanup.
                    diagnostics = {"diagnostics_error_type": type(diagnostics_error).__name__}
                # A timeout after the TUI already died is a symptom: attribute the
                # exit itself rather than the generic TimeoutError.
                exit_attribution: dict[str, object] = {}
                if isinstance(exc, _CodexTerminalExited) or diagnostics.get(
                    "terminal_exited_undetected"
                ):
                    from omnigent.runner.launch_failure import classify_terminal_failure

                    exit_status = diagnostics.get("terminal_exit_status")
                    last_output = diagnostics.get("terminal_last_output")
                    diagnosis = classify_terminal_failure(
                        command="codex",
                        exit_status=exit_status if isinstance(exit_status, int) else None,
                        output=last_output if isinstance(last_output, str) else None,
                    )
                    exit_attribution["error_category"] = (
                        diagnosis.category if diagnosis else ErrorCategory.RUNNER
                    ).value
                failure_event = debug_event("codex_thread_start_failed", session_id=session_id)
                failure_event["attributes"] = {
                    "harness": "codex-native",
                    "phase": "thread_discovery",
                    "reason": (
                        "terminal_exited"
                        if isinstance(exc, _CodexTerminalExited)
                        else "timeout"
                        if isinstance(exc, TimeoutError)
                        else "event_stream_ended"
                    ),
                    "timeout_s": (
                        None
                        if login_required
                        else (
                            thread_start_timeout_seconds
                            if thread_start_timeout_seconds is not None
                            else CODEX_NATIVE_DIRECT_THREAD_START_TIMEOUT_SECONDS
                        )
                    ),
                    "elapsed_ms": round((time.monotonic() - discovery_started_at) * 1000),
                    "login_required": login_required,
                    **diagnostics,
                    **exit_attribution,
                    "error_impact": ErrorImpact.BLOCKING.value,
                    "error_phase": ErrorPhase.HARNESS_STARTUP.value,
                }
                _logger.exception(
                    "Codex TUI never started a thread for %s; chat will not forward%s%s",
                    session_id,
                    (
                        f"\nCodex startup stderr:\n{diagnostics['stderr_tail']}"
                        if diagnostics.get("stderr_tail")
                        else ""
                    ),
                    (
                        f"\nCodex startup terminal output:\n{diagnostics['terminal_last_output']}"
                        if diagnostics.get("terminal_last_output")
                        else ""
                    ),
                    extra=failure_event,
                )
                # Bridge state is never written here; leave the real cause for the executor (#59).
                if isinstance(exc, _CodexTerminalExited):
                    # The app-server stayed healthy; lead with the TUI's actual
                    # failure instead of the generic thread-discovery wrapper.
                    summary = _codex_terminal_exit_summary(exc.instance, before_thread=True)
                else:
                    if isinstance(exc, TimeoutError):
                        timeout_seconds = (
                            thread_start_timeout_seconds
                            if thread_start_timeout_seconds is not None
                            else CODEX_NATIVE_DIRECT_THREAD_START_TIMEOUT_SECONDS
                        )
                        cause = f"startup timed out after {timeout_seconds:g}s"
                    else:
                        cause = "event stream ended before a thread was created"
                    summary = (
                        f"Codex app-server never started a thread ({cause}: {type(exc).__name__})."
                    )
                if app_server is None or _AUTO_CODEX_APP_SERVERS.get(session_id) is app_server:
                    terminal_output = diagnostics.get("terminal_last_output")
                    write_bridge_startup_error(
                        bridge_dir,
                        f"{summary} Launch routing: {routing_summary}. "
                        "(The runner log has the same near 'native-codex routing'.)"
                        + (
                            f"\nCodex startup terminal output:\n{terminal_output}"
                            if terminal_output
                            else ""
                        ),
                        code="codex_thread_not_started",
                    )
                return

        if login_required or startup_pending_recorded:
            # The user signed in (or the TUI otherwise started a thread):
            # the pre-recorded fail-fast cause no longer applies.
            clear_bridge_startup_error(bridge_dir)
        write_bridge_state(
            bridge_dir,
            CodexNativeBridgeState(
                session_id=session_id,
                socket_path=codex_ws_url,
                thread_id=thread_id,
                codex_home=str(codex_home),
                # The session workspace: without it the executor falls back
                # to the runner process's own cwd when starting turns.
                cwd=workspace,
            ),
        )

        server_url = _required_runner_env("RUNNER_SERVER_URL")
        auth_factory = _make_auth_token_factory()
        auth_token = auth_factory() if auth_factory is not None else None
        headers: dict[str, str] = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}

        # Mirror the discovered Codex thread id onto the Omnigent session as its
        # external_session_id, the same way claude-native records its
        # captured session id. This is what makes the session forkable with
        # history: fork_conversation stamps
        # ``omnigent.fork.source_external_session_id`` from
        # external_session_id, and the forked clone's runner clones this
        # thread's rollout from it (see _clone_codex_rollout). Without it a
        # host-spawned codex session has no recorded thread id, so a fork
        # would resume fresh. Best-effort: a transient Omnigent failure here still
        # leaves chat streaming working — only fork-history carry-over
        # degrades.
        from omnigent.cli_auth import open_server_client

        try:
            async with open_server_client(
                server_url,
                headers=headers,
                auth=_RunnerDatabricksAuth(auth_factory),
                timeout=httpx.Timeout(10.0),
            ) as _ext_client:
                _ext_resp = await _ext_client.patch(
                    f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                    json={"external_session_id": thread_id},
                    params={"include_usage": "false"},
                )
            if _ext_resp.status_code >= 400:
                _logger.warning(
                    "AP rejected codex external_session_id PATCH (%s); session=%s thread=%s — "
                    "a fork of this session will resume fresh",
                    _ext_resp.status_code,
                    session_id,
                    thread_id,
                    extra={"session_id": session_id},
                )
        except httpx.HTTPError:
            _logger.warning(
                "Could not record codex external_session_id for %s; a fork of this "
                "session will resume fresh",
                session_id,
                exc_info=True,
            )

        await supervise_forwarder(
            base_url=server_url,
            headers=headers,
            session_id=session_id,
            bridge_dir=bridge_dir,
            app_server_url=codex_ws_url,
            thread_id=thread_id,
            client=event_client,
            auth=_RunnerDatabricksAuth(auth_factory),
        )
    finally:
        # Tear down the listener and the per-session app-server whenever
        # forwarding ends — discovery failed, the app-server connection dropped
        # (``supervise_forwarder`` returned), or the task was cancelled on
        # session teardown. ``supervise_forwarder`` also closes ``event_client``
        # in its own ``finally``; ``close()`` is idempotent. The app-server
        # subprocess is ours to stop, else it orphans one process per session.
        # Pop first so the dict never holds a closed reference.
        _logger.info(
            "Codex native input stopped",
            extra=debug_event(
                "native_input_stopped",
                session_id=session_id,
                harness="codex-native",
                stage="native_input",
            ),
        )
        leftover_app_server = app_server
        if app_server is None or _AUTO_CODEX_APP_SERVERS.get(session_id) is app_server:
            leftover_app_server = _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
        with contextlib.suppress(Exception):
            await event_client.close()
        if leftover_app_server is not None:
            with contextlib.suppress(Exception):
                await leftover_app_server.close()
        await _shutdown_session_turn_router_async(session_id, turn_router)


async def _codex_forward_known_thread(
    *,
    session_id: str,
    bridge_dir: Path,
    codex_ws_url: str,
    thread_id: str,
    client: CodexAppServerClient | None = None,
    turn_router: TurnRouter | None = None,
) -> None:
    """
    Forward a runner-owned Codex terminal that resumes an existing thread.

    :param session_id: Omnigent conversation id, e.g. ``"conv_abc123"``.
    :param bridge_dir: Native Codex bridge directory for this session.
    :param codex_ws_url: App-server loopback URL, e.g.
        ``"ws://127.0.0.1:9876"``.
    :param thread_id: Existing Codex app-server thread id, e.g.
        ``"thread_abc123"``.
    :param client: Retained preload subscription, owned and closed by this forwarder.
    :param turn_router: First-message routing endpoint this launch
        started, torn down in the ``finally``.
    :returns: None. Runs until cancelled or the app-server connection
        closes.
    """
    from omnigent.harnesses.codex_native.forwarder import supervise_forwarder
    from omnigent.runner._entry import (
        _make_auth_token_factory,
        _RunnerDatabricksAuth,
    )

    try:
        server_url = _required_runner_env("RUNNER_SERVER_URL")
        auth_factory = _make_auth_token_factory()
        auth_token = auth_factory() if auth_factory is not None else None
        headers = {"Authorization": f"Bearer {auth_token}"} if auth_token else {}
        await supervise_forwarder(
            base_url=server_url,
            headers=headers,
            session_id=session_id,
            bridge_dir=bridge_dir,
            app_server_url=codex_ws_url,
            thread_id=thread_id,
            client=client,
            auth=_RunnerDatabricksAuth(auth_factory),
        )
    finally:
        if client is not None:
            with contextlib.suppress(Exception):
                await client.close()
        _logger.info(
            "Codex native input stopped",
            extra=debug_event(
                "native_input_stopped",
                session_id=session_id,
                harness="codex-native",
                stage="native_input",
            ),
        )
        leftover_app_server = _AUTO_CODEX_APP_SERVERS.pop(session_id, None)
        if leftover_app_server is not None:
            with contextlib.suppress(Exception):
                await leftover_app_server.close()
        await _shutdown_session_turn_router_async(session_id, turn_router)


async def _session_payload_for_host_spawn_check(
    server_client: httpx.AsyncClient | None,
    session_id: str,
) -> _JsonObject | None:
    """
    Fetch a session snapshot for Codex host-spawn detection.

    :param server_client: The runner's Omnigent server HTTP client, or
        ``None`` in embedded/test setups.
    :param session_id: Session/conversation id, e.g.
        ``"conv_abc123"``.
    :returns: Parsed session JSON object, or ``None`` when the
        snapshot cannot be retrieved.
    """
    if server_client is None:
        return None
    try:
        resp = await server_client.get(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            params=_SESSION_METADATA_PARAMS,
            timeout=10.0,
        )
    except httpx.HTTPError:
        _logger.warning(
            "Could not resolve host_id for %s; skipping codex terminal auto-create",
            session_id,
        )
        return None
    if resp.status_code != 200:
        return None
    try:
        payload = resp.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


async def _codex_session_needs_runner_terminal(
    server_client: httpx.AsyncClient | None,
    session_id: str,
) -> bool:
    """
    Whether the runner must auto-create the Codex terminal for a session.

    The runner owns the terminal for every codex-native session, including
    top-level CLI sessions. Older top-level CLI sessions used to run their
    own app-server/TUI/forwarder; that split ownership caused competing
    setup and teardown. Now all codex-native sessions need runner
    auto-create:

    - **Host-spawned (web-UI) top-level sessions** carry a ``host_id``.
    - **Sub-agent children** (dispatched server-side via
      ``sys_session_send``) carry a ``parent_session_id`` but no
      ``host_id`` of their own. No CLI ever manages a sub-agent terminal,
      so the runner must create it regardless of whether the *parent* was
      host- or CLI-spawned. (Gating on the parent's ``host_id`` was a
      regression: codex-native sub-agents under a CLI-driven parent —
      e.g. polly run via ``omnigent run --server`` — silently never got
      a terminal and the dispatch no-op'd.)

    - **CLI top-level sessions** have neither ``host_id`` nor
      ``parent_session_id`` but still need the runner to own the app-server
      and terminal.

    Returns ``False`` only when the lookup fails; without a session
    snapshot, the runner cannot confirm this is a codex-native session.

    :param server_client: The runner's Omnigent server HTTP client, or ``None`` in
        embedded/test setups.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :returns: ``True`` when the session snapshot exists; ``False`` on
        lookup failure.
    """
    payload = await _session_payload_for_host_spawn_check(server_client, session_id)
    if payload is None:
        return False
    return True


def _codex_native_model_from_spec(agent_spec: AgentSpec | ResolvedSpec | None) -> str | None:
    """
    Read the Codex model default from a resolved agent spec.

    Reads the canonical ``spec.executor.model`` field (the same field the
    in-process codex harness consumes via ``_resolve_spec_model``), falling
    back to ``executor.config["model"]`` for bundle specs that pin the model
    inside the harness config block. Gateway-routed ``databricks-*`` ids are
    valid Codex models on the Databricks path, so they pass through.

    :param agent_spec: Agent spec object, or a resolved wrapper carrying a
        ``spec`` attribute. ``None`` means no spec was available.
    :returns: Model id, e.g. ``"gpt-5.4-mini"``, or ``None``.
    """
    spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    if spec is None:
        return None
    model = spec.executor.model
    if isinstance(model, str) and model:
        return model
    config_model = spec.executor.config.get("model")
    return config_model if isinstance(config_model, str) and config_model else None


def _claude_native_model_from_spec(agent_spec: AgentSpec | ResolvedSpec | None) -> str | None:
    """
    Read the Claude Code model id to launch the native TUI with, from a spec.

    Reads the canonical ``spec.executor.model`` field (the same field the
    in-process claude-sdk harness consumes via ``_resolve_spec_model``).
    Gateway-routed ``databricks-*`` ids are valid Claude Code
    models when the launch is wired through the Databricks AI gateway, so they
    are passed through.

    :param agent_spec: Agent spec object, or a resolved wrapper carrying a
        ``spec`` attribute. ``None`` means no spec was available.
    :returns: A Claude model id, e.g. ``"claude-sonnet-5"``, or ``None`` when
        the spec declares no model pin.
    """
    spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    if spec is None:
        return None
    model = spec.executor.model
    if not isinstance(model, str) or not model:
        return None
    return model


def _native_startup_raw_instructions_from_spec(
    agent_spec: AgentSpec | ResolvedSpec | None,
) -> str | None:
    """Read raw author instructions for a native harness's startup-additive channel.

    Shared by claude-native's ``--append-system-prompt`` and codex-native's
    ``developer_instructions``. Returns the verbatim ``AgentSpec.instructions``
    text only — never the fully framework-composed per-turn string. Terminal
    launch is not tied to any one turn, while the composed string is
    assembled per conversation for the turn about to run (late-bound
    framework text like ``SHARED_SESSION_AUTHORSHIP_INSTRUCTION`` is
    selected per conversation), so a startup channel carrying one turn's
    composition would address every later turn with it.

    :param agent_spec: Agent spec object, or a resolved wrapper carrying a
        ``spec`` attribute. ``None`` means no spec was available.
    :returns: The original resolved instructions text, or ``None`` when
        absent/whitespace-only.
    """
    from omnigent.runtime.prompt import raw_author_instructions

    spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    if spec is None:
        return None
    return raw_author_instructions(spec)


def _pi_native_model_from_spec(agent_spec: AgentSpec | ResolvedSpec | None) -> str | None:
    """
    Read the Pi model id to launch the native TUI with, from a spec.

    Reads the canonical ``spec.executor.model`` field (the same field the
    in-process harnesses consume). A gateway-routed id (``databricks-*``) IS
    usable here: the runner-owned Pi process routes through the Databricks AI
    Gateway, whose ``models.json`` selects the model by its gateway id (see
    :func:`omnigent.harnesses.pi_native.credentials.resolve_pi_native_provider`). The
    resolved model is threaded into ``resolve_pi_native_provider(model=...)``
    so the generated ``models.json`` (and the appended ``--model``) selects
    it.

    :param agent_spec: Agent spec object, or a resolved wrapper carrying a
        ``spec`` attribute. ``None`` means no spec was available.
    :returns: A model id, e.g. ``"databricks-claude-opus-4-7"``, or ``None``
        when the spec declares no model (Pi then uses the provider default).
    """
    spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    if spec is None:
        return None
    model = spec.executor.model
    return model if isinstance(model, str) and model else None


def _agent_os_env_from_spec(
    agent_spec: AgentSpec | ResolvedSpec | None,
) -> OSEnvSpec | None:
    """
    Read the agent's ``os_env`` from a resolved agent spec.

    The auto-created native terminals (codex/claude) must inherit the
    agent's ``os_env`` so its ``sandbox`` (e.g. ``type: none``),
    ``egress_rules`` and ``env_passthrough`` are honoured. Without this
    the terminal is built with a fresh ``OSEnvSpec`` carrying no sandbox,
    and ``launch_terminal`` falls back to ``_default_sandbox_for_platform``
    (``linux_bwrap`` / ``darwin_seatbelt``) — overriding the YAML config.
    Mirrors :func:`create_session_terminal`, which resolves the spec once
    and threads its ``os_env`` through as the inheritance parent.

    :param agent_spec: Agent spec object, or a resolved wrapper carrying a
        ``spec`` attribute. ``None`` means no spec was available.
    :returns: The agent's ``os_env`` spec, or ``None``.
    """
    spec = agent_spec.spec if isinstance(agent_spec, ResolvedSpec) else agent_spec
    if spec is None:
        return None
    return getattr(spec, "os_env", None)


def _is_runner_owned_codex_terminal(
    resource_registry: SessionResourceRegistry,
    resource: SessionResourceView,
) -> bool:
    """
    Return whether an existing ``codex/main`` terminal is the native TUI.

    A generic terminal launched with ``terminal=codex`` has the same public
    resource id but is not the runner-owned Codex TUI. The resource registry
    carries the private role marker that identifies terminals created by
    ``_auto_create_codex_terminal`` without leaking launch argv in public
    metadata.

    A runner-owned pane is still not reusable once its launch has failed and
    its app-server is gone: the pane cannot carry chat turns, so every send
    would fail fast on the saved startup error until the terminal is recreated.
    Reporting it as not owned makes the ensure close it and launch again,
    which also clears the saved error. A pane whose backend is alive (for
    example one still waiting on a sign-in prompt) stays reusable.

    :param resource_registry: Runner resource registry that owns private
        terminal role markers.
    :param resource: Existing terminal resource view.
    :returns: ``True`` when the resource is marked as Codex native and can
        still carry chat turns.
    """
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_bridge_id,
        read_bridge_startup_error,
    )

    if (
        resource_registry.terminal_resource_role(resource.session_id, resource.id)
        != CODEX_NATIVE_TERMINAL_ROLE
    ):
        return False
    if resource.session_id in _AUTO_CODEX_APP_SERVERS:
        return True
    return read_bridge_startup_error(bridge_dir_for_bridge_id(resource.session_id)) is None


def _build_claude_native_base_args(
    *,
    reasoning_effort: str | None,
    model_override: str | None,
    terminal_launch_args: list[str] | None,
    resume_external_session_id: str | None = None,
) -> tuple[str, ...]:
    """
    Assemble the base ``claude`` CLI args for a native-terminal launch.

    These are the args before :func:`augment_claude_args` layers on the
    bridge / MCP / hook / Omnigent wiring. The order is: ``--resume`` for a
    cold resume, then persisted reasoning effort, then the user's
    pass-through ``terminal_launch_args``, then a ``--model`` derived
    from ``model_override`` — appended only when the user did not
    already pass an explicit ``--model``. That precedence (explicit
    ``--model`` in pass-through args wins over ``model_override``)
    mirrors the CLI's ``_merge_default_model_arg``, moved runner-side.
    The ``--resume``-first ordering mirrors the CLI's
    ``(*cold_resume_args, *claude_args)``. See
    designs/NATIVE_RUNNER_SERVER_LAUNCH.md.

    :param reasoning_effort: Persisted per-session effort, e.g.
        ``"high"``. Added as ``--effort <value>`` only when it is one
        of Claude's supported efforts; otherwise ignored. ``None``
        adds nothing (Claude uses its own ``~/.claude/settings.json``
        default).
    :param model_override: Per-session model override, e.g.
        ``"claude-opus-4-7"``. Appended as ``--model <value>`` unless
        the pass-through args already contain a ``--model`` flag.
        ``None`` adds nothing.
    :param terminal_launch_args: The user's pass-through CLI args,
        e.g. ``["--dangerously-skip-permissions"]``. ``None`` or an
        empty list contributes nothing.
    :param resume_external_session_id: Claude-native session id to
        resume, e.g. ``"02857840-6362-408f-b41f-309e396ed7c6"``.
        Prepended as ``--resume <value>`` so Claude reopens the prior
        transcript. A forked clone passes the uuid it assigned to its
        OWN cloned transcript here (see
        :func:`omnigent.harnesses.claude_native.main._clone_claude_transcript`), so
        the same plain ``--resume`` path serves both cold resume and
        fork resume. ``None`` (a fresh launch, or no local transcript
        could be synthesized) adds nothing.
    :returns: The assembled base args, e.g.
        ``("--resume", "<sid>", "--effort", "high")``.
    """
    from omnigent.util.reasoning_effort import CLAUDE_EFFORTS

    args: list[str] = []
    if resume_external_session_id:
        args.extend(("--resume", resume_external_session_id))
    if reasoning_effort is not None and reasoning_effort in CLAUDE_EFFORTS:
        args.extend(("--effort", reasoning_effort))
    if terminal_launch_args:
        args.extend(terminal_launch_args)
    # model_override is a default: it applies only when the user did
    # not pass their own ``--model`` (in either the long ``--model X``
    # or the joined ``--model=X`` form).
    if model_override and not any(arg == "--model" or arg.startswith("--model=") for arg in args):
        args.extend(("--model", model_override))
    return tuple(args)


def _claude_terminal_env_unset(
    claude_config: ClaudeNativeUcodeConfig | None,
) -> list[str]:
    """
    Env vars to strip from a native Claude terminal child.

    Always drops ``DATABRICKS_CONFIG_PROFILE`` so the terminal's MCP
    servers don't inherit the runner's ambient Databricks profile and
    resolve auth against the wrong workspace.

    Always drops ``CLAUDECODE`` because Claude Code rejects any child launch
    carrying that nested-session marker, regardless of its auth mode. When the
    launch config carries an ``apiKeyHelper``, also drops the raw
    ``ANTHROPIC_API_KEY``: seeing both opens Claude Code's "Detected a custom
    API key" menu, whose selected row uses the same ``❯`` glyph the tmux
    delivery path waits for, so the first web message is typed into the menu.

    :param claude_config: The resolved native launch config, or ``None``
        (Claude's own login) — which still strips the nested-session marker.
    :returns: The env var names to unset, e.g.
        ``["DATABRICKS_CONFIG_PROFILE", "CLAUDECODE", "ANTHROPIC_API_KEY"]``.
    """
    env_unset = ["DATABRICKS_CONFIG_PROFILE", "CLAUDECODE"]
    if claude_config is not None and claude_config.api_key_helper:
        env_unset.append("ANTHROPIC_API_KEY")
    return env_unset


def _publish_terminal_pending(
    publish_event: Callable[[str, _JsonObject], None],
    session_id: str,
    pending: bool,
) -> None:
    """
    Publish a terminal spin-up status event onto the session stream.

    Emitted by the auto-create path so the web UI can show a spinner on
    the Terminal pill while the runner boots a terminal-first session's
    terminal, and clear it once the terminal lands or auto-create
    fails. The Omnigent relay caches the latest value and republishes it, and
    seeds the ``terminal_pending`` snapshot field, so a client that
    connects mid-spin-up still sees the spinner. ``pending=False`` is
    what distinguishes "still starting up" from "no terminal" (killed /
    never created): once cleared, the client relies purely on whether a
    terminal resource exists.

    :param publish_event: The runner's per-session SSE emitter,
        ``(session_id, event_dict) -> None``.
    :param session_id: Session/conversation identifier,
        e.g. ``"conv_abc123"``.
    :param pending: ``True`` when a terminal is being created (show the
        spinner); ``False`` to clear it (terminal landed, or
        auto-create raised).
    """
    publish_event(
        session_id,
        {"type": "session.terminal_pending", "pending": pending},
    )


def _measured_prefix_bytes(transcript_path: Path) -> int | None:
    """
    Measure a just-written resume transcript so the forwarder can skip exactly it.

    Taken before Claude launches, while the file holds only the synthesized
    prefix. ``None`` on any read failure, which leaves the forwarder on its
    live end-offset fallback.

    :param transcript_path: Resume transcript this launch wrote, e.g.
        ``Path("~/.claude/projects/-Users-me-repo/<sid>.jsonl")``.
    :returns: File size in bytes, or ``None`` when it cannot be measured.
    """
    try:
        return transcript_path.stat().st_size
    except OSError:
        _logger.warning(
            "Could not measure synthesized Claude resume transcript; "
            "forwarder will seed from the live transcript end; transcript=%s",
            transcript_path,
            exc_info=True,
            extra={"session_id": runner_primary_session_id()},
        )
        return None


_ERRNO_CHAIN_MAX_DEPTH = 3


def _os_error_with_errno(exc: BaseException) -> OSError | None:
    """
    Find an ``OSError`` with a known errno in ``exc`` or its short cause chain.

    Walks ``__cause__``/``__context__`` a few links so a wrapping exception
    (e.g. a ``RuntimeError`` raised from a disk-full ``OSError``) still
    surfaces the errno.

    :param exc: Exception raised by the native terminal creation path.
    :returns: The first ``OSError`` with a non-``None`` ``errno``, or
        ``None`` if the chain has none.
    """
    current: BaseException | None = exc
    for _ in range(_ERRNO_CHAIN_MAX_DEPTH):
        if current is None:
            return None
        if isinstance(current, OSError) and current.errno is not None:
            return current
        current = current.__cause__ or current.__context__
    return None


def _native_terminal_start_failure_cause(exc: BaseException) -> str:
    """
    Summarize a native terminal start exception using only structured facts.

    Never includes free-form exception text (which can carry launch paths or
    other sensitive detail) — only the exception type, an OS errno name
    (walking a short cause chain), an ``OmnigentError`` code, or the direct
    cause's type name.

    :param exc: Exception raised by the native terminal creation path,
        e.g. ``OSError(28, "No space left on device")``.
    :returns: e.g. ``"OSError errno 28 ENOSPC"`` or
        ``"RuntimeError (cause ReadTimeout)"``.
    """
    class_name = type(exc).__name__
    os_error = _os_error_with_errno(exc)
    if os_error is not None:
        assert os_error.errno is not None
        errno_name = errno.errorcode.get(os_error.errno)
        detail = f"errno {os_error.errno}"
        if errno_name:
            detail = f"{detail} {errno_name}"
        return f"{class_name} {detail}"
    if isinstance(exc, OmnigentError):
        if exc.__cause__ is not None:
            return f"{class_name} code {exc.code} (cause {type(exc.__cause__).__name__})"
        return f"{class_name} code {exc.code}"
    if exc.__cause__ is not None:
        return f"{class_name} (cause {type(exc.__cause__).__name__})"
    return class_name


def _native_terminal_start_error_payload(
    exc: BaseException, runtime_name: str, *, session_id: str
) -> dict[str, str]:
    """
    Build the structured error payload for a native terminal start failure.

    :param exc: Exception raised by the native terminal creation path,
        e.g. ``ImportError("Native Codex requires the 'codex' CLI on PATH.")``.
    :param runtime_name: Human-readable runtime name, e.g. ``"Codex"``.
    :param session_id: Session whose terminal failed, which may be a runner's child.
    :returns: ``{"code": ..., "message": ...}`` payload for SSE and
        JSON error responses. Known actionable configuration errors surface
        their safe message directly; other causes point to the runner log.
    """
    error_id = f"err_{uuid.uuid4().hex}"
    missing_agent = isinstance(exc, OmnigentError) and exc.code == ErrorCode.SESSION_AGENT_MISSING
    extra = debug_event(
        "native_terminal_start_failed",
        session_id=session_id,
        error_id=error_id,
        runtime=runtime_name,
        code=ErrorCode.SESSION_AGENT_MISSING
        if missing_agent
        else _NATIVE_TERMINAL_START_FAILED_CODE,
        exception_type=type(exc).__name__,
        exception_cause_type=type(exc.__cause__).__name__ if exc.__cause__ is not None else None,
        cause_code=exc.code if isinstance(exc, OmnigentError) else None,
        # The warning below carries no exc_info for a missing agent, so the
        # sink cannot derive its category.
        error_category=exc.category.value
        if isinstance(exc, OmnigentError) and missing_agent
        else None,
        error_impact=ErrorImpact.BLOCKING.value,
    )
    if missing_agent:
        # Expected session-lifecycle condition: the session's agent was deleted
        # or rebound, so its bundle no longer resolves. This is not a
        # terminal-startup defect — log it without a stack and surface a
        # distinct code plus a client-safe message (never the internal
        # resolver text) so KPI/error attribution reflects the lifecycle event
        # rather than a generic runner startup fault.
        _logger.warning(
            "Native %s terminal skipped; session agent unavailable; error_id=%s: %s",
            runtime_name,
            error_id,
            exc,
            extra=extra,
        )
        return {
            "code": ErrorCode.SESSION_AGENT_MISSING,
            "error_id": error_id,
            "message": (
                "This session's agent is no longer available; it was deleted "
                "or replaced. Recreate the agent or start a new session, then "
                f"retry. Error ID: {error_id}."
            ),
        }
    _logger.warning(
        "Native %s terminal start failed; error_id=%s: %s",
        runtime_name,
        error_id,
        exc,
        exc_info=exc,
        extra=extra,
    )
    from omnigent.harnesses.claude_native.bridge import ClaudeNativeHookInterpreterMismatchError
    from omnigent.terminals.registry import TerminalExitedDuringLaunch

    if runtime_name == "Codex" and isinstance(exc, TerminalExitedDuringLaunch):
        message = _codex_terminal_exit_summary(exc.instance, before_thread=False)
        # A failed diagnostic read must not hide the known terminal-exit cause.
        with contextlib.suppress(Exception):
            if output := _codex_startup_terminal_output(exc.instance):
                message += f"\nCodex startup terminal output:\n{output}"
    elif isinstance(exc, ClaudeNativeHookInterpreterMismatchError):
        message = (
            "Claude Code is Windows-native, but Omnigent is running under WSL. "
            "Install @anthropic-ai/claude-code from WSL so a WSL-native `claude` "
            "binary wins PATH resolution, then retry."
        )
    elif IS_WINDOWS:
        # Native terminals are tmux/PTY-based and disabled on Windows by design.
        # Give the client an actionable message instead of a log pointer.
        message = (
            f"Native {runtime_name} terminal (tmux/PTY) is not supported on "
            "Windows. Use an SDK-based harness (e.g. claude-sdk or pi) for "
            "this agent, or run it on Linux/macOS."
        )
    else:
        log_reference = process_log_reference("runner")
        cause = _native_terminal_start_failure_cause(exc)
        message = (
            f"Native {runtime_name} terminal failed to start ({cause}); "
            f"see the runner log for details: {log_reference}"
        )
    return {
        "code": _NATIVE_TERMINAL_START_FAILED_CODE,
        "error_id": error_id,
        "message": f"{message} Error ID: {error_id}.",
    }


def _publish_native_terminal_start_error(
    publish_event: Callable[[str, _JsonObject], None],
    session_id: str,
    runtime_name: str,
    exc: BaseException,
) -> dict[str, str]:
    """
    Publish live failure events for a native terminal start failure.

    The runner stays alive: the affected session receives
    ``session.status: failed`` with the structured cause, while resource
    panels and the relay keep working. The runner does not publish a
    bare ``response.error`` here because terminal auto-create happens
    outside a transcript turn; Omnigent writes and publishes the turn-scoped
    ``response.error`` only when it consumes a user message that cannot
    run because the terminal is failed.

    :param publish_event: The runner's per-session SSE emitter,
        ``(session_id, event_dict) -> None``.
    :param session_id: Session/conversation identifier,
        e.g. ``"conv_abc123"``.
    :param runtime_name: Human-readable runtime name, e.g. ``"Claude"``.
    :param exc: The startup exception whose text should be surfaced.
    :returns: The structured error payload that was published on the
        status event.
    """
    error = _native_terminal_start_error_payload(exc, runtime_name, session_id=session_id)
    publish_event(
        session_id,
        {
            "type": "session.status",
            "status": "failed",
            "error": error,
        },
    )
    return error


def _native_terminal_start_error_response(
    exc: BaseException, runtime_name: str, *, session_id: str
) -> JSONResponse:
    """
    Return a structured JSON error for native terminal ensure failures.

    :param exc: Exception raised by terminal auto-create.
    :param runtime_name: Human-readable runtime name, e.g. ``"Codex"``.
    :param session_id: Session whose terminal ensure failed.
    :returns: HTTP 500 response with an ``error`` object carrying the
        real failure message.
    """
    return JSONResponse(
        status_code=500,
        content={
            "error": _native_terminal_start_error_payload(exc, runtime_name, session_id=session_id)
        },
    )


def _codex_ensure_response_with_policy_notice(
    session_id: str, terminal_view: SessionResourceView
) -> JSONResponse:
    """
    Build the codex terminal-ensure 200 response with a one-shot notice.

    When the codex app-server degraded to "no policy enforcement"
    (fail-open — codex too old or trust failed), attach the reason as
    ``policy_hook_disabled_reason`` exactly once so Omnigent can post a single
    durable web-UI banner. The app-server's one-shot flag is cleared
    after the first surface, so repeated ensures (each user message
    re-probes) do not re-post the notice.

    Must be called while holding the per-session codex ensure lock
    (``_codex_terminal_ensure_locks[session_id]``): the read-and-clear of
    ``policy_notice_pending`` is only one-shot because that lock
    serializes concurrent ensures for the same session.

    :param session_id: Session/conversation identifier, e.g.
        ``"conv_abc123"``.
    :param terminal_view: The runner-owned codex terminal resource view
        to return.
    :returns: A 200 JSON response, optionally carrying
        ``policy_hook_disabled_reason``.
    """
    body = session_resource_view_to_dict(terminal_view)
    app_server = _AUTO_CODEX_APP_SERVERS.get(session_id)
    if (
        app_server is not None
        and app_server.policy_notice_pending
        and app_server.policy_hook_disabled_reason
    ):
        body["policy_hook_disabled_reason"] = app_server.policy_hook_disabled_reason
        app_server.policy_notice_pending = False
    return JSONResponse(status_code=200, content=body)


def _ensure_orchestrator_skills_in_bundle(
    bundle_dir: Path,
    agent_spec: object,
) -> None:
    """
    Link the ``build-omnigent`` skill into a bundle's ``skills/`` dir.

    Called before native bridge launches so ``--plugin-dir`` (claude) or
    ``CODEX_HOME/skills/`` (codex) picks up the skill. Injects
    unconditionally for every agent — every ``omnigent claude`` /
    ``omnigent codex`` user should be able to author new agents. The
    skill isn't already present guard is idempotent. Best-effort: a
    failure to link is logged but does not abort the terminal launch.

    :param bundle_dir: Materialized agent-bundle root, e.g.
        ``/tmp/omnigent-ap-chat-xyz/bundle``.
    :param agent_spec: The session's AgentSpec (unused after gate
        removal; retained for call-site compat).
    """
    del agent_spec  # no longer gated; inject unconditionally
    skill_name = "build-omnigent"
    target_dir = bundle_dir / "skills" / skill_name
    if target_dir.exists():
        return
    # Anchored on the package root, not a ``.parent`` count off this file:
    # moving this module deeper must not silently break the source path.
    source = _OMNIGENT_PACKAGE_DIR / "onboarding" / "agent" / "skills" / skill_name
    if not source.is_dir():
        _logger.debug(
            "Orchestrator skill source %s is not a directory; skipping injection",
            source,
            extra={"session_id": runner_primary_session_id()},
        )
        return
    try:
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        target_dir.symlink_to(source)
    except OSError:
        _logger.debug(
            "Could not link %s skill into bundle %s",
            skill_name,
            bundle_dir,
            exc_info=True,
            extra={"session_id": runner_primary_session_id()},
        )


#: Recall and long-term memory must run without a permission prompt, or the
#: model stalls on it (same "don't ask" denial session_history hit).
_ROLLOVER_ALLOWED_TOOLS: tuple[str, ...] = (
    "mcp__omnigent__session_history",
    "mcp__omnigent__memory_remember",
    "mcp__omnigent__memory_search",
    "mcp__omnigent__memory_get",
    "mcp__omnigent__memory_explain",
    "mcp__omnigent__memory_forget",
)

_CLAUDE_LAUNCH_PERMISSION_MODES = frozenset(
    {"default", "auto", "acceptEdits", "plan", "dontAsk", "bypassPermissions"}
)


def _claude_launch_permission_mode(args: list[str] | None) -> str | None:
    """Return the effective known launch mode without logging arbitrary args."""
    from omnigent.harnesses.claude_native.bridge import (
        _arg_value,
        _args_request_bypass_permissions,
    )

    launch_args = tuple(args or ())
    if _args_request_bypass_permissions(launch_args):
        return "bypassPermissions"
    candidate = _arg_value(launch_args, "--permission-mode")
    return candidate if candidate in _CLAUDE_LAUNCH_PERMISSION_MODES else None


@dataclasses.dataclass(frozen=True)
class _ClaudeSessionLaunchMetadata:
    """Persisted values consumed by Claude terminal launch."""

    reasoning_effort: str | None = None
    model_override: str | None = None
    terminal_launch_args: list[str] | None = None
    external_session_id: str | None = None
    fork_source_external_id: str | None = None
    fork_carry_history: bool = False
    #: From ``routing_class_from_snapshot``, so an auto-harness session (e.g. a
    #: sub-agent child of a routed parent, which carries the auto-harness label
    #: but no ``cost_control_mode_override``) reads as routing-enabled too.
    routing_enabled: bool = False
    #: The first-message routing hook still has work to do. False once the
    #: session carries a routing decision — a web create routes the model
    #: before the pane launches — so no prompt is ever held and replayed.
    turn_routing: bool = False


def _claude_launch_metadata_from_envelope(
    session_init: RunnerSessionInitEnvelope,
) -> _ClaudeSessionLaunchMetadata:
    """Project Claude launch metadata without server callbacks."""
    from omnigent.runner.subagent_routing import routing_class_from_snapshot
    from omnigent.stores.conversation_store import (
        FORK_CARRY_HISTORY_LABEL_KEY,
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
    )

    snapshot = session_init.snapshot
    fork_source = snapshot.labels.get(FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY)
    routing_class = routing_class_from_snapshot(
        cost_control_mode=snapshot.cost_control_mode_override,
        harness_override=snapshot.harness_override,
        labels=snapshot.labels,
    )
    return _ClaudeSessionLaunchMetadata(
        routing_enabled=routing_class.routing_enabled,
        turn_routing=routing_class.turn_routing,
        reasoning_effort=snapshot.reasoning_effort,
        model_override=snapshot.model_override,
        terminal_launch_args=snapshot.terminal_launch_args,
        external_session_id=snapshot.external_session_id,
        fork_source_external_id=(
            fork_source if isinstance(fork_source, str) and fork_source else None
        ),
        fork_carry_history=snapshot.labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1",
    )


async def _load_legacy_claude_launch_metadata(
    server_client: httpx.AsyncClient,
    session_id: str,
) -> _ClaudeSessionLaunchMetadata:
    """Fetch Claude launch metadata for servers predating the init envelope."""
    from omnigent.runner.subagent_routing import routing_class_from_snapshot
    from omnigent.stores.conversation_store import (
        FORK_CARRY_HISTORY_LABEL_KEY,
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
    )

    try:
        response = await server_client.get(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            params=_SESSION_METADATA_PARAMS,
            timeout=10.0,
        )
    except httpx.HTTPError:
        _logger.debug(
            "Could not fetch session launch config for %s; terminal will use Claude's defaults",
            session_id,
        )
        return _ClaudeSessionLaunchMetadata()
    if response.status_code != 200:
        return _ClaudeSessionLaunchMetadata()

    snapshot = response.json()
    effort = snapshot.get("reasoning_effort")
    model_override = snapshot.get("model_override")
    launch_args = snapshot.get("terminal_launch_args")
    external_session_id = snapshot.get("external_session_id")
    labels = snapshot.get("labels")
    labels = labels if isinstance(labels, dict) else {}
    fork_source = labels.get(FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY)
    cost_control_mode = snapshot.get("cost_control_mode_override")
    harness_override = snapshot.get("harness_override")
    routing_class = routing_class_from_snapshot(
        cost_control_mode=cost_control_mode if isinstance(cost_control_mode, str) else None,
        harness_override=harness_override if isinstance(harness_override, str) else None,
        labels={str(key): str(value) for key, value in labels.items()},
    )
    metadata = _ClaudeSessionLaunchMetadata(
        routing_enabled=routing_class.routing_enabled,
        turn_routing=routing_class.turn_routing,
        reasoning_effort=effort if isinstance(effort, str) and effort else None,
        model_override=(
            model_override if isinstance(model_override, str) and model_override else None
        ),
        terminal_launch_args=(
            launch_args
            if isinstance(launch_args, list) and all(isinstance(arg, str) for arg in launch_args)
            else None
        ),
        external_session_id=(
            external_session_id
            if isinstance(external_session_id, str) and external_session_id
            else None
        ),
        fork_source_external_id=(
            fork_source if isinstance(fork_source, str) and fork_source else None
        ),
        fork_carry_history=labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1",
    )
    permission_mode = _claude_launch_permission_mode(metadata.terminal_launch_args)
    _logger.info(
        "Claude terminal launch config fetched: session=%s status=%s effort_set=%s "
        "model_override_set=%s launch_args_count=%d permission_mode=%s "
        "external_session_id_set=%s",
        session_id,
        response.status_code,
        metadata.reasoning_effort is not None,
        metadata.model_override is not None,
        len(metadata.terminal_launch_args or []),
        permission_mode,
        metadata.external_session_id is not None,
        extra=debug_event(
            "claude_launch_config_loaded",
            session_id=session_id,
            **({"permission_mode": permission_mode} if permission_mode is not None else {}),
        ),
    )
    return metadata


async def _load_claude_launch_metadata(
    *,
    server_client: httpx.AsyncClient,
    session_id: str,
    session_init: RunnerSessionInitEnvelope | None,
) -> _ClaudeSessionLaunchMetadata:
    """Dispatch between the removable legacy and callback-free loaders."""
    if session_init is None:
        return await _load_legacy_claude_launch_metadata(server_client, session_id)
    metadata = _claude_launch_metadata_from_envelope(session_init)
    permission_mode = _claude_launch_permission_mode(metadata.terminal_launch_args)
    _logger.info(
        "Claude terminal launch config loaded from init envelope: session=%s "
        "effort_set=%s model_override_set=%s launch_args_count=%d permission_mode=%s "
        "external_session_id_set=%s",
        session_id,
        metadata.reasoning_effort is not None,
        metadata.model_override is not None,
        len(metadata.terminal_launch_args or []),
        permission_mode,
        metadata.external_session_id is not None,
        extra=debug_event(
            "claude_launch_config_loaded",
            session_id=session_id,
            **({"permission_mode": permission_mode} if permission_mode is not None else {}),
        ),
    )
    return metadata


async def _clear_session_model_override(
    session_id: str,
    server_client: httpx.AsyncClient,
    *,
    expected_model_override: str | None = None,
) -> None:
    """
    Reset a session's persisted model pick to Default.

    Conditional resets preserve a selection made during launch. An older
    server rejects the conditional endpoint, retaining the pick for retry.
    Legacy callers use the explicit ``"default"`` alias; JSON null is a no-op.

    :param session_id: Session/conversation identifier.
    :param server_client: Runner Omnigent server client.
    :param expected_model_override: Only clear this original launch-time pick.
    """
    try:
        session_path = f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}"
        if expected_model_override is not None:
            resp = await server_client.post(
                f"{session_path}/model-override/reset",
                json={"expected_model_override": expected_model_override},
                timeout=10.0,
            )
        else:
            resp = await server_client.patch(
                session_path,
                json={"model_override": "default"},
                params={"include_usage": "false"},
                timeout=10.0,
            )
        resp.raise_for_status()
    except (httpx.HTTPError, RuntimeError):
        _logger.warning(
            "native terminal: could not reset the model pick for session %s",
            session_id,
            exc_info=True,
        )


async def _auto_create_claude_terminal(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    server_client: httpx.AsyncClient,
    event_dispatcher: RunnerEventDispatcher | None = None,
    bundle_dir: Path | None = None,
    agent_name: str | None = None,
    agent_spec: AgentSpec | ResolvedSpec | None = None,
    skills_filter: str | list[str] = "all",
    session_init: RunnerSessionInitEnvelope | None = None,
    auth_token_factory: Callable[[], str | None] | None = None,
    resolve_launch_config: Callable[[], Awaitable[ClaudeNativeUcodeConfig | None]] | None = None,
    record_launch_config: Callable[[str, ClaudeNativeUcodeConfig | None], None] | None = None,
) -> SessionResourceView:
    """
    Auto-create a Claude Code terminal for a claude-native session.

    Called when the runner receives a claude-native session via
    ``POST /v1/sessions`` and no terminal exists yet. This handles
    the host-spawned runner case where no CLI client is present to
    create the terminal.

    :param session_id: Session/conversation identifier,
        e.g. ``"conv_abc123"``.
    :param resource_registry: Session resource registry for
        launching the terminal.
    :param publish_event: The runner's per-session SSE emitter, used to
        surface the new terminal on the live stream (the Omnigent relay
        republishes it to the web UI) so the Terminal toggle enables
        without a refresh.
    :param server_client: Omnigent server client used to fetch the session
        snapshot so the terminal inherits the persisted
        ``reasoning_effort``.
    :param bundle_dir: Materialized agent-bundle root when the session's
        agent ships a ``skills/`` directory, resolved by the caller
        (which has the runner's spec resolver). Threaded to
        :func:`augment_claude_args` so Claude Code discovers bundled
        skills via ``--plugin-dir``. ``None`` adds no plugin args.
    :param agent_name: Agent display name for the bundle's plugin
        manifest, e.g. ``"researcher"``. ``None`` falls back to the
        bundle directory's basename.
    :param agent_spec: Optional resolved agent spec for the session. Its
        ``os_env`` (sandbox / egress_rules / env_passthrough) is threaded
        through as the terminal's inheritance parent so the YAML sandbox
        config (e.g. ``type: none``) is honoured instead of being
        overridden by ``_default_sandbox_for_platform``.
    :param skills_filter: The agent spec's ``skills_filter`` (``"all"``
        / ``"none"`` / list of skill names), threaded to
        :func:`augment_claude_args`. Defaults to ``"all"``.
    :param session_init: Versioned server snapshot. ``None`` selects the
        isolated legacy callback path.
    :param auth_token_factory: Runner-owned refreshable bearer factory.
        ``None`` preserves direct-call behavior by resolving one locally.
    :param resolve_launch_config: Optional per-session resolver shared with
        the model-options endpoint so launch and UI use one catalog query.
    :param record_launch_config: Optional callback that stores the exact
        provider/model snapshot used for this session's launch.
    :returns: The launched terminal's :class:`SessionResourceView`, so
        callers that create it on demand (the resume "ensure" path in
        :func:`create_session_terminal`) can return the resource.
    """
    from pathlib import Path

    from omnigent.harnesses.claude_native.bridge import (
        BRIDGE_ID_LABEL_KEY,
        augment_claude_args,
        ensure_claude_workspace_trusted,
        prepare_bridge_dir,
        validate_claude_hook_interpreter_compatibility,
    )
    from omnigent.harnesses.claude_native.forwarder import reset_transcript_forward_state
    from omnigent.inner.datamodel import OSEnvSpec, TerminalEnvSpec

    workspace = (
        session_init.snapshot.workspace
        if session_init is not None and session_init.snapshot.workspace
        else _runner_workspace_dir()
    )
    # A rollover session sets Claude Code's own auto-compaction ceiling, sized
    # below once the launch model is known.
    from omnigent.context.labels import is_rollover

    session_labels = session_init.snapshot.labels if session_init is not None else None
    # Without a startup snapshot (e.g. a relaunch), read the labels live so a
    # rollover session never launches without its setup.
    rollover_labels: Mapping[str, str] | None = session_labels
    if session_init is None:
        rollover_labels = await _session_labels_for_runner_spawn(
            server_client=server_client, session_id=session_id
        )
    rollover = is_rollover(rollover_labels)
    from omnigent.runtime.prompt import ROLLOVER_NATIVE_INSTRUCTIONS

    started_at = time.monotonic()
    _logger.info(
        "Claude terminal auto-create starting: session=%s workspace=%s bundle_dir=%s "
        "agent_name=%s skills_filter=%s",
        session_id,
        workspace,
        bundle_dir,
        agent_name,
        skills_filter,
        extra={"session_id": session_id},
    )
    # Pick the bridge id this session's dir is keyed on. Normally session_id,
    # and we (re)assert the label = session_id so a STALE label from a rotation
    # that timed out before its terminal transfer can't make
    # _ensure_comment_relay_started write tool_relay.json to the wrong dir.
    #
    # EXCEPTION: a session superseded by /clear is deliberately re-keyed to
    # "{session_id}-cleared" (see _create_clear_replacement_session). Its natural
    # D(session_id) is the NEW session's live pane; resuming there would share
    # one transcript with two forwarders (duplicate items) and trip the
    # "no longer active after /clear" guard. So when the label is exactly that
    # marker, honour it and resume in the session's own isolated dir. The
    # executor spawn_env already resolves the same label, so the two agree.
    cleared_bridge_id = f"{session_id}-cleared"
    existing_bridge_id = await _claude_native_bridge_id_with_optional_labels(
        server_client=server_client,
        session_id=session_id,
        session_labels=session_labels,
    )
    bridge_id = cleared_bridge_id if existing_bridge_id == cleared_bridge_id else session_id
    if session_init is not None:
        # The transfer-inbound guard has already consumed the original label.
        # From this point this terminal owns the bridge, so later first-turn
        # helpers must observe the normalized id selected here.
        session_init.snapshot.labels[BRIDGE_ID_LABEL_KEY] = bridge_id
    else:
        try:
            await server_client.patch(
                f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                json={"labels": {BRIDGE_ID_LABEL_KEY: bridge_id}},
                params={"include_usage": "false"},
            )
        except httpx.HTTPError:
            _logger.debug(
                "Could not set bridge_id label for %s; relay may target wrong dir",
                session_id,
            )
    # Capture the previous claude_session_id from the bridge state file BEFORE
    # prepare_bridge_dir unlinks it. read_claude_session_id reads _STATE_FILE,
    # which prepare_bridge_dir removes as part of its refresh; reading it here
    # lets the cold-resume fallback below use it when the server GET missed the
    # external_session_id binding (e.g. workspace-scope ContextVar not set).
    from omnigent.harnesses.claude_native.bridge import (
        bridge_dir_for_bridge_id as _bridge_dir_for_bridge_id,
    )
    from omnigent.harnesses.claude_native.bridge import (
        read_claude_session_id as _read_csid_pre_wipe,
    )

    _pre_wipe_claude_sid = _read_csid_pre_wipe(_bridge_dir_for_bridge_id(bridge_id))
    # Resolved once here and reused below (env_spec) so the bridge's own
    # sys_os_* tools and the terminal process see the same sandbox — the
    # agent's declared os_env.sandbox, already overridden by any
    # enforce_sandbox/force_sandbox policy verdict upstream.
    agent_os_env = _agent_os_env_from_spec(agent_spec)
    bridge_dir = prepare_bridge_dir(
        session_id,
        bridge_id=bridge_id,
        workspace=Path(workspace),
        sandbox=(agent_os_env.sandbox if agent_os_env is not None else None),
    )
    if rollover:
        from omnigent.harnesses.claude_native.bridge import require_mcp_before_input

        require_mcp_before_input(bridge_dir)
    # Cancel any surviving forwarder BEFORE wiping its cursor/seen state, else it
    # re-posts with fresh dedup state alongside the forwarder spawned below.
    await _cancel_auto_forwarder_task(session_id)
    reset_transcript_forward_state(bridge_dir)
    _logger.info(
        "Claude terminal bridge prepared: session=%s",
        session_id,
        extra={"session_id": session_id},
    )
    # Pre-accept Claude's first-run trust + onboarding TUI prompts for this
    # workspace. They have no PermissionRequest hook, so on a host-spawned
    # (web-UI-driven) session they would hang Claude in its terminal with
    # nothing shown in the UI. Acute with per-session worktrees,
    # which launch Claude in a brand-new, untrusted directory.
    ensure_claude_workspace_trusted(Path(workspace))

    from omnigent.runner._entry import _make_auth_token_factory, _RunnerDatabricksAuth

    # The Omnigent server URL + auth are needed in two places below: the
    # PermissionRequest hook (so Claude's approval prompts route to the
    # web UI instead of its TUI) and the transcript forwarder. The CLI
    # client supplies these on the wrapper path; on this host-spawned
    # path the runner reuses its process-level auth context.
    server_url = os.environ.get("RUNNER_SERVER_URL", "http://localhost:6767")
    # Authenticate the runner's outbound POSTs the same way its other
    # HTTP calls are authenticated.
    _auth_factory = auth_token_factory
    if _auth_factory is None:
        _auth_factory = _make_auth_token_factory()
    # The hook reads an owner-only header snapshot that the parent refreshes.
    # The forwarder uses refresh-capable auth directly; ``None`` is a no-op.
    _auth_token = _auth_factory() if _auth_factory is not None else None
    # The hook subprocess replays these static headers from its config (no
    # refresh-capable auth of its own); the helper pairs the bearer with the
    # workspace-routing header so neither is dropped.
    from omnigent.cli_auth import databricks_request_headers

    _runner_headers = databricks_request_headers(server_url, bearer_token=_auth_token)
    _runner_auth = _RunnerDatabricksAuth(_auth_factory)

    from omnigent.harnesses.claude_native.main import (
        build_native_claude_terminal_env,
        claude_config_with_launch_model_pinned,
        claude_config_with_routed_arms_pinned,
        resolve_claude_native_model_selection,
        resolve_native_claude_config,
    )

    launch_metadata = await _load_claude_launch_metadata(
        server_client=server_client,
        session_id=session_id,
        session_init=session_init,
    )
    session_effort = launch_metadata.reasoning_effort
    session_model_override = launch_metadata.model_override
    session_launch_args = launch_metadata.terminal_launch_args
    session_external_id = launch_metadata.external_session_id
    fork_source_external_id = launch_metadata.fork_source_external_id
    fork_carry_history = launch_metadata.fork_carry_history

    # The server GET may miss the external_session_id binding when the
    # reconnect request arrives without a workspace-scoped context (the
    # ContextVar defaults to 0 on fresh tasks). Fall back to the claude_session_id
    # captured from the bridge state file before prepare_bridge_dir wiped it.
    if session_external_id is None and _pre_wipe_claude_sid is not None:
        session_external_id = _pre_wipe_claude_sid
        _logger.info(
            "cold-resume fallback: server snapshot missing external_session_id, "
            "using local bridge hint: session=%s local_claude_sid=%s",
            session_id,
            _pre_wipe_claude_sid,
            extra={"session_id": session_id},
        )

    # Cold resume: when this session wraps a prior Claude session,
    # synthesize the local ``~/.claude/projects/<workspace>/<sid>.jsonl``
    # transcript that Claude's ``--resume`` reads, then pass ``--resume``.
    # The CLI does this client-side via ``_resolve_cold_resume_args``;
    # doing it here lets a daemon / web-UI launch resume too. Best-effort:
    # on any failure we launch fresh rather than point ``--resume`` at a
    # transcript that doesn't exist. See
    # designs/NATIVE_RUNNER_SERVER_LAUNCH.md.
    resume_external_session_id: str | None = None
    # Byte length of the resume transcript this launch synthesized, measured
    # BEFORE Claude starts. The forwarder seeds its cursor from this rather than
    # from a live end-offset: resolving the transcript path needs Claude's first
    # hook, and the executor's prompt inject waits on the same boot, so a
    # ``stat`` taken later routinely skips the freshly-injected message.
    resume_prefix_bytes: int | None = None
    if server_client is not None and session_external_id is not None:
        from omnigent.harnesses.claude_native.main import _ensure_local_claude_resume_transcript

        try:
            _transcript = await _ensure_local_claude_resume_transcript(
                server_client,
                session_id=session_id,
                external_session_id=session_external_id,
                workspace=Path(workspace).resolve(),
                bridge_dir=bridge_dir,
            )
            if _transcript is not None:
                resume_external_session_id = session_external_id
                resume_prefix_bytes = _measured_prefix_bytes(_transcript)
        except Exception:
            _logger.warning(
                "Could not synthesize Claude resume transcript for %s; launching without --resume",
                session_id,
                exc_info=True,
            )
    elif session_external_id is None and fork_source_external_id is not None:
        # Forked clone with no native session yet: clone the SOURCE's
        # local Claude transcript into the clone's OWN project dir under a
        # uuid we assign — rewriting per-record sessionId/cwd — then launch
        # plain ``--resume <our_uuid>``. Writing the file ourselves before
        # launch means the forwarder's ``start_at_end`` seeks past the
        # copied prefix (no double-render), and placing it in the clone's
        # own project dir means cwd-scoped ``--resume`` finds it in any
        # dir/worktree. Only viable when the source transcript exists on
        # THIS host (same-host fork — CUJ 1 same-user); else launch fresh.
        # See designs/FORK_SESSION_UX.md.
        from omnigent.harnesses.claude_native.main import _clone_claude_transcript

        our_uuid = str(uuid.uuid4())
        _clone_workspace = Path(workspace).resolve()
        try:
            _cloned = _clone_claude_transcript(
                source_external_session_id=fork_source_external_id,
                target_external_session_id=our_uuid,
                clone_workspace=_clone_workspace,
            )
        except Exception:
            _cloned = None
            _logger.warning(
                "Could not clone source transcript for forked clone %s; launching fresh",
                session_id,
                exc_info=True,
            )
        _logger.info(
            "Claude terminal fork-resume decision: session=%s source_ext=%s "
            "our_uuid=%s clone_workspace=%s cloned_transcript=%s",
            session_id,
            fork_source_external_id,
            our_uuid,
            _clone_workspace,
            str(_cloned) if _cloned is not None else None,
            extra={"session_id": session_id},
        )
        if _cloned is not None:
            # Resume our OWN clone (plain --resume, no --fork-session).
            resume_external_session_id = our_uuid
            resume_prefix_bytes = _measured_prefix_bytes(_cloned)
            # Record the assigned id now so Omnigent reflects the clone's own
            # Claude session immediately, and a later relaunch resumes it
            # via the normal cold-resume path (this branch is gated on
            # external_session_id being unset). Best-effort.
            if server_client is not None:
                try:
                    await server_client.patch(
                        f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                        json={"external_session_id": our_uuid},
                        params={"include_usage": "false"},
                        timeout=10.0,
                    )
                except httpx.HTTPError:
                    _logger.warning(
                        "Could not pre-set external_session_id for forked clone %s; "
                        "relying on hook capture",
                        session_id,
                        exc_info=True,
                    )
    elif (
        server_client is not None
        and fork_carry_history
        and session_external_id is None
        and fork_source_external_id is None
    ):
        # Forked clone bound to a native target with NO source native
        # transcript to clone (an SDK or cross-family source): build the clone's
        # native transcript from its OWN copied Omnigent items under a uuid we
        # assign, then launch plain ``--resume <our_uuid>``. This reuses the
        # same server-items→transcript converter the cross-machine cold
        # resume path uses (``_ensure_local_claude_resume_transcript``), so
        # the clone opens with the prior conversation (messages + tool
        # history) as real Claude context. Best-effort: launch fresh on
        # failure. See designs/FORK_SESSION_UX.md.
        from omnigent.harnesses.claude_native.main import _ensure_local_claude_resume_transcript

        our_uuid = str(uuid.uuid4())
        _clone_workspace = Path(workspace).resolve()
        try:
            _built = await _ensure_local_claude_resume_transcript(
                server_client,
                session_id=session_id,
                external_session_id=our_uuid,
                workspace=_clone_workspace,
                bridge_dir=bridge_dir,
            )
        except Exception:
            _built = None
            _logger.warning(
                "Could not build native transcript from items for forked clone %s; "
                "launching fresh",
                session_id,
                exc_info=True,
            )
        _logger.info(
            "Claude terminal fork-rebuild decision: session=%s our_uuid=%s "
            "clone_workspace=%s built_transcript=%s",
            session_id,
            our_uuid,
            _clone_workspace,
            str(_built) if _built is not None else None,
            extra={"session_id": session_id},
        )
        if _built is not None:
            resume_external_session_id = our_uuid
            resume_prefix_bytes = _measured_prefix_bytes(_built)
            # Record the assigned id so Omnigent reflects the clone's own Claude
            # session and a later relaunch resumes it via the cold-resume
            # path above. Best-effort, mirroring the clone branch.
            try:
                await server_client.patch(
                    f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
                    json={"external_session_id": our_uuid},
                    params={"include_usage": "false"},
                    timeout=10.0,
                )
            except httpx.HTTPError:
                _logger.warning(
                    "Could not pre-set external_session_id for forked clone %s; "
                    "relying on hook capture",
                    session_id,
                    exc_info=True,
                )
    _logger.info(
        "Claude terminal cold-resume decision: session=%s external_session_id_set=%s "
        "fork_source_set=%s resume_enabled=%s",
        session_id,
        session_external_id is not None,
        fork_source_external_id is not None,
        resume_external_session_id is not None,
        extra={"session_id": session_id},
    )

    # Derive the ucode (Databricks gateway) launch config from the
    # runner's own profile so a daemon / web-UI-launched Claude
    # authenticates to the gateway exactly like a CLI-launched one —
    # the CLI injects this in ``_claude_terminal_request``; on this path
    # the runner must, since it (not the CLI) launches the terminal.
    # Best-effort: no profile / no ucode state / malformed state falls
    # back to Claude's own native config (empty env).
    # See designs/NATIVE_RUNNER_SERVER_LAUNCH.md.
    # Resolve the launch config across all offerings — a configured provider
    # (omnigent setup), a Databricks ucode profile from provider config, or
    # Claude's own login — so a host-spawned native-claude session honors the
    # provider selection just like the in-process claude-sdk harness and the
    # CLI path.
    claude_config: ClaudeNativeUcodeConfig | None = None
    _launch_config_resolution_failed = False
    from omnigent.inference_config import (
        binding_for_harness,
        load_runtime_inference_config,
        resolve_bound_model,
    )

    inference_config = load_runtime_inference_config()
    claude_binding = binding_for_harness(inference_config, "claude-native")
    try:
        if resolve_launch_config is not None:
            claude_config = await resolve_launch_config()
        else:
            claude_config = await asyncio.to_thread(resolve_native_claude_config, spec=None)
    except click.ClickException:
        # An authoritative Databricks response with no Claude models is a
        # configuration failure, not permission to bypass the gateway.
        raise
    except Exception:
        if claude_binding is not None:
            raise
        _logger.warning(
            "native-claude: could not derive a provider/ucode launch config "
            "— FALLING BACK to Claude Code's own login; "
            "your configured provider will NOT be used. Check "
            "`omnigent setup` "
            "and that the secret resolves in this process.",
            exc_info=True,
            extra={"session_id": session_id},
        )
        _launch_config_resolution_failed = True
    # A transient resolver failure must not be cached as "no provider configured".
    # A routed session's turn-1 ``/model`` can only reach ids this launch env
    # spells, so point the family aliases at the router's frozen arms before the
    # launch model is derived from them.
    if launch_metadata.routing_enabled:
        from omnigent.server.smart_routing import task_v1_claude_arms

        claude_config = claude_config_with_routed_arms_pinned(claude_config, task_v1_claude_arms())
    # The launch model without the session's pick: the agent-spec pin, else
    # the provider's own default. Also what a pick the provider cannot serve
    # falls back to.
    unpinned_launch_model = resolve_claude_native_model_selection(
        _claude_native_model_from_spec(agent_spec)
        or (claude_config.model if claude_config is not None else None),
        claude_config,
    )
    launch_model = (
        resolve_claude_native_model_selection(session_model_override, claude_config)
        if session_model_override
        else unpinned_launch_model
    )
    if claude_binding is not None:
        unpinned_launch_model = resolve_bound_model(
            inference_config, "claude-native", _claude_native_model_from_spec(agent_spec)
        )
        launch_model = resolve_bound_model(
            inference_config, "claude-native", session_model_override or unpinned_launch_model
        )
    # A pick the provider cannot serve is dropped only once the fallback
    # terminal is actually up, so a failed launch never loses it.
    reset_pick_after_launch = False
    # Explicit launches (model-flows design §4): consult the shared catalog
    # only when it can change the outcome — to validate an explicit request,
    # or to resolve a Default launch that would otherwise pass no ``--model``
    # and leave the model to invisible CLI-private state.
    # Bound here so the vocabulary record below reads the same rows the
    # launch validated against, whether or not that validation ran.
    launch_catalog: list[dict[str, object]] | None = None
    if claude_binding is None and (session_model_override or launch_model is None):
        from omnigent.harnesses.claude_native.main import (
            claude_catalog_launch_spelling,
            claude_catalog_serves_model,
            claude_launch_catalog,
            claude_launch_catalog_is_stale,
            claude_launch_endpoint_label,
            claude_reprobed_launch_catalog,
        )
        from omnigent.models.model_catalog_store import default_row

        launch_catalog_was_stale = False
        try:
            # Read staleness BEFORE the fetch: the fetch itself kicks the
            # background re-probe, which could land between the two reads and
            # make a same-launch check call yesterday's rows fresh.
            launch_catalog_was_stale = claude_launch_catalog_is_stale(claude_config)
            launch_catalog = await claude_launch_catalog(claude_config)
        except Exception:
            _logger.warning(
                "claude launch catalog unavailable for session=%s",
                session_id,
                exc_info=True,
                extra={"session_id": session_id},
            )
        if session_model_override and launch_catalog:
            pick = session_model_override
            resolved_request = resolve_claude_native_model_selection(pick, claude_config) or pick

            def _serves_pick(rows: list[dict[str, object]]) -> bool:
                """
                Whether *rows* serve the pick by its persisted or resolved spelling.
                """
                # A pane's ``/model`` persists the exact id it runs; the catalog
                # may spell that model only by its family alias.
                return claude_catalog_serves_model(
                    rows, pick, claude_config
                ) or claude_catalog_serves_model(rows, resolved_request, claude_config)

            # A spec pin or routing pick can spell a served model in the
            # gateway/catalog namespace ("system.ai.claude-opus-4-8[1m]")
            # while the launch catalog lists the same model bare; folding the
            # mechanical prefix away keeps the pick launchable on the
            # catalog's own spelling instead of falling back to the default.
            def _fold_pick(rows: list[dict[str, object]]) -> str | None:
                """
                The rows' launch spelling for the pick's persisted or resolved id.
                """
                # The custom picker slot resolves to a provider-configured id
                # (e.g. "system.ai.claude-sonnet-5"), so like _serves_pick the
                # fold must consult both spellings.
                return claude_catalog_launch_spelling(
                    rows, pick
                ) or claude_catalog_launch_spelling(rows, resolved_request)

            folded_spelling = _fold_pick(launch_catalog)
            # Only rows that are fresh may retire the pick: a stale entry may
            # predate a provider change, so it is re-probed first, and a
            # failed probe leaves no fresh rows at all. A foldable pin counts
            # as an exact serve for staleness: it launches on the stale rows'
            # spelling without a re-probe, like the exact-serve stale path.
            fresh_rows: list[dict[str, object]] | None = launch_catalog
            if (
                launch_catalog_was_stale
                and not _serves_pick(launch_catalog)
                and folded_spelling is None
            ):
                fresh_rows = await claude_reprobed_launch_catalog(claude_config)
                if fresh_rows:
                    launch_catalog = fresh_rows
                    launch_catalog_was_stale = False
                    folded_spelling = _fold_pick(launch_catalog)
            if not _serves_pick(launch_catalog):
                if folded_spelling is not None:
                    _logger.info(
                        "claude launch gate folded the pinned model %r onto the catalog "
                        "spelling %r for session=%s",
                        pick,
                        folded_spelling,
                        session_id,
                        extra={"session_id": session_id},
                    )
                    launch_model = folded_spelling
                else:
                    # The pick outlives the provider it was made under (a later
                    # ``omnigent setup`` can re-point the default). Launch on what
                    # this provider serves; reset the pick to Default only on fresh
                    # evidence, so the picker shows what the session now runs.
                    offered = ", ".join(
                        str(row.get("id") or row.get("model") or "") for row in launch_catalog
                    )
                    if fresh_rows:
                        reset_pick_after_launch = True
                        outcome = (
                            "launching on the provider default and resetting the pick to Default"
                        )
                    else:
                        outcome = (
                            "the re-probe failed, so launching on the provider default and "
                            "keeping the pick for the next relaunch"
                        )
                    _logger.warning(
                        "claude-native: model pick %r for session %s is not served by %s "
                        "(it offers: %s); %s",
                        pick,
                        session_id,
                        claude_launch_endpoint_label(claude_config),
                        offered,
                        outcome,
                        extra={"session_id": session_id},
                    )
                    launch_model = unpinned_launch_model
        if launch_model is None and launch_catalog:
            # A stale entry's default is yesterday's answer: pinning it as
            # ``--model`` turns a provider-side retirement or entitlement
            # change into a hard launch failure. Launch bare instead — the
            # CLI's own default is servable by construction, and the
            # harness's ``reported_model`` records what it actually ran —
            # while the store's background re-probe converges the catalog.
            if launch_catalog_was_stale:
                _logger.info(
                    "claude catalog for session=%s is stale; deferring the Default "
                    "launch to the CLI's own default model",
                    session_id,
                )
            else:
                catalog_default = default_row(launch_catalog)
                if catalog_default is not None:
                    launch_model = (
                        str(catalog_default.get("model") or catalog_default.get("id") or "")
                        or None
                    )
    # Size the rollover ceiling from the settled launch model's window.
    compact_at_tokens = _rollover_compact_at(rollover_labels, model=launch_model)
    # Give an exact launch model (a Smart Routing pick is resolved before the
    # terminal exists) a spelling of its own in the picker, so a later
    # ``/model`` can return to it instead of stepping onto whatever the family
    # alias points at. Recorded below, so the picker and the launch agree.
    # Routed launches only: the pin writes ``ANTHROPIC_CUSTOM_MODEL_OPTION``,
    # and on a plain session that displaces the workspace's own picker row for
    # no gain — nothing later re-picks the launch model there.
    if launch_metadata.routing_enabled:
        claude_config = claude_config_with_launch_model_pinned(claude_config, launch_model)
    if record_launch_config is not None and not _launch_config_resolution_failed:
        record_launch_config(session_id, claude_config)
    # Persist the vocabulary + launch model onto the bridge so mid-session
    # ``/model`` conversion reads THIS session's pins, not the runner's
    # ambient env (the CLI path records these at prepare time; the runner
    # resolves its config only after the bridge exists).
    from omnigent.harnesses.claude_native.bridge import record_model_vocabulary
    from omnigent.harnesses.claude_native.main import stored_claude_picker_values

    await asyncio.to_thread(
        record_model_vocabulary,
        bridge_dir,
        launch_env=claude_config.env if claude_config is not None else None,
        launch_model=launch_model,
        # The catalog rows are the CLI's own picker, so their ids are the
        # spellings a later ``/model`` can type — a managed picker names
        # rows no pin covers.
        picker_values=stored_claude_picker_values(claude_config, launch_catalog),
    )
    _logger.info(
        "Claude terminal provider config resolved: session=%s configured=%s "
        "env_keys=%s api_key_helper_set=%s model_set=%s launch_model=%s",
        session_id,
        claude_config is not None,
        sorted(claude_config.env) if claude_config is not None else [],
        bool(claude_config.api_key_helper) if claude_config is not None else False,
        bool(claude_config.model) if claude_config is not None else False,
        launch_model,
        extra={"session_id": session_id},
    )
    base_claude_args = _build_claude_native_base_args(
        reasoning_effort=session_effort,
        # Precedence: per-session ``/model`` override > agent-spec pin
        # (``executor.model``) > provider/ucode default. All three yield to an
        # explicit ``--model`` in the user's pass-through args (handled in the
        # helper).
        model_override=launch_model,
        terminal_launch_args=session_launch_args,
        resume_external_session_id=resume_external_session_id,
    )

    # Pass ``ap_server_url`` so ``build_hook_settings`` registers the
    # claude-native ``PermissionRequest`` command hook and writes
    # permission_hook.json. Without it, the hook is silently omitted and
    # approval prompts never reach the web UI on this host-spawned path.
    # ``bundle_dir`` / ``skills_filter`` (resolved by the caller, which
    # has the spec resolver) expose a bundle's ``skills/`` to Claude Code
    # via ``--plugin-dir`` — the CLI mirror of the SDK plugin wiring.
    # ``api_key_helper`` (ucode) registers Claude's gateway token command.
    # First-message model routing. Advertised in the same bridge dir the
    # ``UserPromptSubmit`` hook is pointed at (so the hook needs no env of its
    # own), and live before the terminal launches because the hook can fire on
    # the very first prompt the user types.
    _claude_turn_router = _start_turn_router_for_native_session(
        session_id,
        bridge_dir=bridge_dir,
        harness="claude-native",
        server_client=server_client,
        turn_routing=launch_metadata.turn_routing,
    )
    # Crash recovery for a blocked-but-never-replayed prompt is not wired here:
    # the pending record on disk is the seam if it ever is, and the recovery's
    # default readiness probe waits on a codex bridge thread.
    claude_args = augment_claude_args(
        base_claude_args,
        bridge_dir=bridge_dir,
        ap_server_url=server_url,
        ap_auth_headers=_runner_headers,
        bundle_dir=bundle_dir,
        agent_name=agent_name,
        skills_filter=skills_filter,
        api_key_helper=claude_config.api_key_helper if claude_config is not None else None,
        model_overrides=claude_config.model_overrides if claude_config is not None else None,
        append_system_prompt="\n\n".join(
            x
            for x in [
                _native_startup_raw_instructions_from_spec(agent_spec),
                ROLLOVER_NATIVE_INSTRUCTIONS if rollover else None,
            ]
            if x
        )
        or None,
        allowed_tools=_ROLLOVER_ALLOWED_TOOLS if rollover else (),
        # The route-turn hook is registered only when this session can
        # actually route; otherwise every submit would pay its round trip.
        turn_routing=_claude_turn_router is not None,
    )

    # Apply the per-harness startup command/args override from config
    # (``harness.claude-native.{command,args}`` in ~/.omnigent/config.yaml) so a
    # downstream integration can wrap this managed-host launch — e.g. Databricks'
    # ``isaac`` sets ``command: isaac`` + ``args: ["--"]`` to run
    # ``isaac -- <augmented args>`` (the config args prepend, and augmentation
    # appended above, so the ``--`` stays first). Identity by default.
    from omnigent.config import load_effective_config  # noqa: FlagLocalImports
    from omnigent.harness_startup_config import (  # noqa: FlagLocalImports
        resolve_harness_args,
        resolve_harness_command,
    )

    _harness_cfg = load_effective_config()
    launch_command = resolve_harness_command("claude-native", default="claude", cfg=_harness_cfg)
    launch_args = resolve_harness_args("claude-native", tuple(claude_args), cfg=_harness_cfg)
    # Validate the binary this terminal will actually spawn: ``launch_command``
    # already reflects the OMNIGENT_CLAUDE_PATH / config overrides, and a bare
    # name resolves against this process's inherited PATH (same lookup tmux's
    # pane shell and omnigent.inner.terminal perform). Mirrors
    # ``_preflight_local_tools`` on the local-CLI path.
    resolved_claude = resolve_cli_binary(launch_command)
    if resolved_claude is not None:
        validate_claude_hook_interpreter_compatibility(resolved_claude)

    claude_terminal_env_unset = _claude_terminal_env_unset(claude_config)

    # Inherit the agent's os_env so its sandbox (e.g. ``type: none``),
    # egress_rules and env_passthrough are honoured. Without ``sandbox`` here
    # and ``parent_os_env`` below, launch_terminal falls back to
    # _default_sandbox_for_platform (linux_bwrap), overriding the YAML config.
    # ``agent_os_env`` was already resolved above for ``prepare_bridge_dir``,
    # so the terminal process and the bridge's sys_os_* tools agree.
    env_spec = TerminalEnvSpec(
        os_env=OSEnvSpec(
            type="caller_process",
            cwd=workspace,
            sandbox=(agent_os_env.sandbox if agent_os_env is not None else None),
        ),
        command=launch_command,
        args=launch_args,
        # Tool Search env plus ucode gateway env (ANTHROPIC_BASE_URL
        # etc.) when derived. Empty provider config still forces
        # ENABLE_TOOL_SEARCH=true so MCP schemas are loaded on demand.
        env=build_native_claude_terminal_env(claude_config, compact_at_tokens=compact_at_tokens),
        # Names to strip (see ``_claude_terminal_env_unset``). Dropping
        # ``DATABRICKS_CONFIG_PROFILE`` matters because Claude's MCP servers
        # inherit this env and several build ``WorkspaceClient`` without pinning
        # ``auth_type``: a set profile makes the SDK prefer that profile's cached
        # OAuth token over the MCP's explicit token, 400ing against the wrong
        # workspace. Claude itself ignores the var (routing is
        # ``ANTHROPIC_BASE_URL`` / ``apiKeyHelper``), so this affects only MCPs;
        # ones needing a specific profile must set it in their own per-MCP env.
        env_unset=claude_terminal_env_unset,
        scrollback=50000,
        # Keep the private tmux server alive if the `claude` CLI exits (e.g. a
        # sub-agent worker whose CLI exits right after rendering its prompt on
        # some hosts — #540). Without this, that exit reaps the server and every
        # later control command (send-keys / model / effort / interrupt / stop)
        # fails with "no server running", and the delegated message is silently
        # lost. With it, the dead pane persists (capturable for diagnostics) and
        # the watcher reports the exit deterministically via `#{pane_dead}`.
        keep_alive_after_exit=True,
    )
    _logger.info(
        "Claude terminal tmux launch requested: session=%s command=%s args_count=%d "
        "env_keys=%s cwd=%s scrollback=%d",
        session_id,
        env_spec.command,
        len(env_spec.args),
        sorted(env_spec.env),
        workspace,
        env_spec.scrollback,
        extra={"session_id": session_id},
    )
    try:
        terminal_view = await resource_registry.launch_required_terminal(
            session_id=session_id,
            terminal_name="claude",
            session_key="main",
            spec=env_spec,
            parent_os_env=agent_os_env,
            # Mark this as the claude-native agent terminal so its pane
            # activity drives the session's PTY-derived working status.
            resource_role=CLAUDE_NATIVE_TERMINAL_ROLE,
        )
    except (Exception, asyncio.CancelledError) as launch_error:
        # Preserve the original failure even if diagnostic cleanup is cancelled.
        if not isinstance(launch_error, asyncio.CancelledError):
            _logger.exception(
                "Claude terminal tmux launch failed: session=%s elapsed_ms=%.0f",
                session_id,
                (time.monotonic() - started_at) * 1000,
                extra={"session_id": session_id},
            )
        from omnigent.harnesses.claude_native.diagnostics import ClaudeDebugLogFollower

        with contextlib.suppress(Exception):
            await asyncio.to_thread(ClaudeDebugLogFollower(bridge_dir).close, session_id)
        raise
    if reset_pick_after_launch:
        await _clear_session_model_override(session_id, server_client)
    # Surface the terminal on the live SSE stream so an already-connected
    # web UI enables the Terminal toggle immediately. The required-terminal
    # launch helper registers the resource and starts the activity watcher but
    # does not publish; the tool / REST launch paths emit this same event via
    # _emit_terminal_resource_event. Without it, this auto-created terminal
    # is only discovered on reconnect (snapshot-on-connect), so the toggle
    # stays gray until the user refreshes.
    from omnigent.entities.session_resources import session_resource_view_to_dict

    terminal_payload = session_resource_view_to_dict(terminal_view)
    terminal_metadata = terminal_payload.get("metadata")
    if not isinstance(terminal_metadata, dict):
        terminal_metadata = {}
    _logger.info(
        "Claude terminal tmux launch returned: session=%s terminal_id=%s running=%s "
        "tmux_socket=%s tmux_target=%s elapsed_ms=%.0f",
        session_id,
        terminal_payload.get("id"),
        terminal_metadata.get("running"),
        terminal_metadata.get("tmux_socket"),
        terminal_metadata.get("tmux_target"),
        (time.monotonic() - started_at) * 1000,
        extra={"session_id": session_id},
    )

    publish_event(
        session_id,
        {
            "type": "session.resource.created",
            "resource": terminal_payload,
        },
    )
    _publish_tmux_target_for_bridge(
        resource_registry=resource_registry,
        session_id=session_id,
        # Use the SAME bridge id the dir was prepared under (``bridge_id``,
        # which is the "-cleared" fork for a /clear-superseded resume, else
        # session_id). Hardcoding session_id here would write tmux.json into
        # D(session_id) while the executor + forwarder read D(bridge_id) — the
        # "tmux target not advertised yet" mismatch on a resumed old session.
        bridge_id=bridge_id,
        terminal_name="claude",
        session_key="main",
    )
    from omnigent.harnesses.claude_native.bridge import _claude_prompt_rendered

    _schedule_terminal_interactive_observer(
        session_id=session_id,
        resource_registry=resource_registry,
        terminal_name="claude",
        session_key="main",
        harness="claude-native",
        readiness_signal="claude_composer",
        is_interactive=_claude_prompt_rendered,
    )
    _logger.info(
        "Claude terminal tmux target published: session=%s bridge_id=%s",
        session_id,
        bridge_id,
        extra={"session_id": session_id},
    )

    # Start the transcript forwarder so Claude's responses flow
    # back to the Omnigent server. Normally the CLI client runs this,
    # but for host-spawned sessions there is no CLI. Reuses the
    # ``server_url`` + auth computed above; ``auth`` refreshes the
    # bearer token per request so forwarding outlives token expiry.
    #
    # ``start_at_end`` must be ``True`` on resume: when
    # ``resume_external_session_id`` is set we launched Claude with
    # ``--resume`` over a transcript synthesized from AP's committed
    # history (see ``_ensure_local_claude_resume_transcript`` above), so
    # offset 0 already holds every item Omnigent has. Starting the forwarder at
    # offset 0 would re-post the whole transcript as new external
    # conversation items — there is no server-side dedup — duplicating the
    # visible history on every resume. A genuinely fresh
    # session (no ``--resume``) starts with an empty transcript, so
    # ``False`` correctly forwards everything from the beginning. This
    # mirrors the CLI client's ``prepared.cold_resumed`` handling in
    # ``claude_native.py``.
    from omnigent.harnesses.claude_native.forwarder import supervise_forwarder

    async def _supervise_bridge() -> None:
        try:
            await supervise_forwarder(
                base_url=server_url,
                headers=_runner_headers,
                session_id=session_id,
                bridge_dir=bridge_dir,
                agent_name="claude-native-ui",
                start_at_end=resume_external_session_id is not None,
                start_at_offset=resume_prefix_bytes,
                auth=_runner_auth,
                event_dispatcher=event_dispatcher,
            )
        finally:
            await _shutdown_session_turn_router_async(session_id, _claude_turn_router)

    _forwarder_task = asyncio.create_task(
        _supervise_bridge(),
        name=f"claude-forwarder-{session_id}",
    )
    _register_auto_forwarder_task(session_id, _forwarder_task)
    _logger.info(
        "Auto-created claude terminal + forwarder for session %s; "
        "forwarder_task=%s elapsed_ms=%.0f",
        session_id,
        _forwarder_task.get_name(),
        (time.monotonic() - started_at) * 1000,
    )
    return terminal_view


async def _auto_create_repl_terminal(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    server_client: httpx.AsyncClient,
    agent_spec: AgentSpec | ResolvedSpec | None = None,
) -> SessionResourceView:
    """
    Auto-create an Omnigent REPL terminal for a runner-hosted SDK session.

    Called when the runner receives a non-native (SDK-harness) top-level
    session via ``POST /v1/sessions`` and no REPL terminal exists yet. The
    terminal hosts the framework's own TUI (``omnigent attach
    <session_id> --server <url>``) in a tmux pane, exposed through the
    standard terminal-attach WebSocket so the web UI embeds it exactly
    like the claude-/codex-native terminals — with the Omnigent REPL as
    the TUI.

    The REPL is a pure co-drive client: it joins the live session over
    HTTP+SSE and dispatches turns to this runner, so the web chat view and
    the embedded terminal stay in sync. The tmux command is deferred until
    the first client attaches (``tmux_start_on_attach``): a session whose
    terminal is never opened pays only for an idle tmux pane, and by first
    attach the session is fully live (``omnigent attach`` fails loud on a
    non-live session) with the REPL sized to the real attached terminal.

    Auth parity with the native terminals: the spawned ``omnigent
    attach`` resolves credentials for ``--server`` the same way a
    user-launched CLI does (``OMNIGENT_REMOTE_AUTH_TOKEN`` env → stored
    OIDC token from ``omnigent login`` → ``~/.databrickscfg``), which
    holds because the runner lives on the user's machine.

    :param session_id: Session/conversation identifier,
        e.g. ``"conv_abc123"``.
    :param resource_registry: Session resource registry for launching the
        terminal.
    :param publish_event: The runner's per-session SSE emitter,
        ``(session_id, event_dict) -> None``, used to surface the new
        terminal on the live stream so the web UI's Terminal pill enables
        without a refresh.
    :param server_client: Omnigent server client used to stamp the
        ``omnigent.ui: terminal`` presentation label that makes the web
        UI show the Chat/Terminal toggle.
    :returns: The launched terminal's :class:`SessionResourceView`.
    """
    from omnigent._wrapper_labels import UI_MODE_LABEL_KEY, UI_MODE_TERMINAL_VALUE
    from omnigent.inner.datamodel import OSEnvSpec, TerminalEnvSpec

    started_at = time.monotonic()
    workspace = _runner_workspace_dir()
    server_url = os.environ.get("RUNNER_SERVER_URL", "http://localhost:6767")
    # Inherit the agent's os_env so its sandbox (e.g. ``type: none``) is honoured;
    # without sandbox= here and parent_os_env below, launch_terminal falls back to
    # _default_sandbox_for_platform (linux_bwrap), which fails in a hardened
    # container. Mirrors the #175 fix on the codex/claude auto-create paths.
    agent_os_env = _agent_os_env_from_spec(agent_spec)
    env_spec = TerminalEnvSpec(
        os_env=OSEnvSpec(
            type="caller_process",
            cwd=workspace,
            sandbox=(agent_os_env.sandbox if agent_os_env is not None else None),
        ),
        # The runner's interpreter is the venv with omnigent installed;
        # ``python -m omnigent`` avoids depending on the console script
        # being on the tmux pane's PATH.
        command=sys.executable,
        args=["-m", "omnigent", "attach", session_id, "--server", server_url],
        scrollback=50000,
        # Defer the REPL process until the first web client attaches (see
        # docstring): no cost for never-opened terminals, and the REPL
        # starts against the real attached terminal size.
        tmux_start_on_attach=True,
    )
    terminal_view = await resource_registry.launch_auxiliary_terminal(
        session_id=session_id,
        terminal_name=_REPL_TERMINAL_NAME,
        session_key=_REPL_TERMINAL_SESSION_KEY,
        spec=env_spec,
        parent_os_env=agent_os_env,
        # Runner-private marker the attach WebSocket uses to recreate
        # this terminal when its tmux session has died (the REPL exited
        # or crashed) instead of rejecting the attach.
        resource_role=OMNIGENT_REPL_TERMINAL_ROLE,
    )
    # Stamp the presentation label that gates the web UI's Chat/Terminal
    # pill (web TerminalFirstContext). Stamped here — not at session
    # creation — so only sessions whose runner actually hosts a REPL
    # terminal get the toggle; in-process (runner-less) sessions never
    # show a dead pill. The ``omnigent.wrapper`` label is deliberately
    # NOT set: these sessions stay chat-first, the terminal is a
    # secondary view.
    try:
        await server_client.patch(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            json={"labels": {UI_MODE_LABEL_KEY: UI_MODE_TERMINAL_VALUE}},
            params={"include_usage": "false"},
        )
    except httpx.HTTPError:
        _logger.warning(
            "Could not stamp %s label for %s; the web Terminal toggle may not appear",
            UI_MODE_LABEL_KEY,
            session_id,
        )
    # Surface the terminal on the live SSE stream so an already-connected
    # web UI enables the Terminal toggle immediately (the auxiliary-terminal
    # launch helper registers the resource but does not publish — mirrors the
    # claude-native auto-create path).
    from omnigent.entities.session_resources import session_resource_view_to_dict

    terminal_payload = session_resource_view_to_dict(terminal_view)
    publish_event(
        session_id,
        {
            "type": "session.resource.created",
            "resource": terminal_payload,
        },
    )
    _logger.info(
        "Auto-created omnigent REPL terminal for session %s: terminal_id=%s "
        "server_url=%s elapsed_ms=%.0f",
        session_id,
        terminal_payload.get("id"),
        server_url,
        (time.monotonic() - started_at) * 1000,
    )
    return terminal_view


async def _delete_native_bridge_dirs(
    *,
    server_client: httpx.AsyncClient | None,
    session_id: str,
) -> None:
    """
    Remove native-harness bridge directories and attachment caches for a session.

    Each native harness keeps a per-conversation bridge dir under
    ``/tmp/omnigent-<uid>/<harness>-native/<digest>`` (some use ``~/.omnigent``)
    holding a bridge token / auth secret + MCP config — secret material. Closing
    the pane does not remove it, so without this they accumulate even on a clean
    session delete (issue #1350). We don't know which harness this session used,
    so delete every candidate dir for the native families (claude/codex/pi);
    the per-target ``FileNotFoundError`` swallow makes wrong-harness / already-gone
    cases a no-op, while other ``OSError``s are logged at debug rather than hidden.
    Claude/codex bridge ids can be rotated via a session label, so resolve those
    too (falling back to *session_id*, the un-rotated key); pi keys purely on
    *session_id*.

    :param server_client: Omnigent server client used to resolve rotated bridge
        id labels. ``None`` skips label resolution (session_id keys only).
    :param session_id: Omnigent session/conversation id, e.g. ``"conv_abc123"``.
    """
    from omnigent.harnesses.claude_native.bridge import (
        BRIDGE_ID_LABEL_KEY,
    )
    from omnigent.harnesses.claude_native.bridge import (
        bridge_dir_for_bridge_id as claude_bridge_dir,
    )
    from omnigent.harnesses.codex_native.bridge import (
        CODEX_NATIVE_BRIDGE_ID_LABEL_KEY,
    )
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_bridge_id as codex_bridge_dir,
    )
    from omnigent.harnesses.pi_native.bridge import (
        bridge_dir_for_session_id as pi_bridge_dir,
    )
    from omnigent.inner.native_attachments import attachment_cache_dir

    labels: dict[str, str] = {}
    if server_client is not None:
        labels = (
            await _session_labels_for_runner_spawn(
                server_client=server_client,
                session_id=session_id,
            )
            or {}
        )

    targets = {
        claude_bridge_dir(labels.get(BRIDGE_ID_LABEL_KEY) or session_id),
        claude_bridge_dir(session_id),
        codex_bridge_dir(labels.get(CODEX_NATIVE_BRIDGE_ID_LABEL_KEY) or session_id),
        codex_bridge_dir(session_id),
        pi_bridge_dir(session_id),
    }
    # A cache can survive a missing bridge directory, including after a reboot.
    targets.update(attachment_cache_dir(target) for target in tuple(targets))
    for target in targets:
        try:
            shutil.rmtree(target, ignore_errors=False)
        except FileNotFoundError:
            pass
        except OSError as exc:
            _logger.debug(
                "Failed to remove native session directory %s for session %s: %s",
                target,
                session_id,
                exc,
            )


async def _claude_native_bridge_id_for_session(
    *,
    server_client: httpx.AsyncClient,
    session_id: str,
    session_labels: Mapping[str, str] | None = None,
) -> str:
    """Resolve the bridge id label for a Claude-native session.

    :param server_client: Omnigent server client used to fetch the session
        snapshot.
    :param session_id: Omnigent session/conversation id, e.g.
        ``"conv_abc123"``.
    :param session_labels: Labels supplied by the initialization envelope.
        ``None`` selects the legacy labels callback.
    :returns: Opaque bridge id from
        ``omnigent.claude_native.bridge_id`` when present, otherwise
        *session_id* for legacy single-session bridges.
    """
    from omnigent.harnesses.claude_native.bridge import BRIDGE_ID_LABEL_KEY

    labels = (
        session_labels
        if session_labels is not None
        else await _session_labels_for_runner_spawn(
            server_client=server_client,
            session_id=session_id,
        )
        or {}
    )
    bridge_id = labels.get(BRIDGE_ID_LABEL_KEY)
    if isinstance(bridge_id, str) and bridge_id:
        return bridge_id
    return session_id


async def _claude_native_bridge_id_with_optional_labels(
    *,
    server_client: httpx.AsyncClient,
    session_id: str,
    session_labels: Mapping[str, str] | None,
) -> str:
    """Preserve the exact legacy helper call when no envelope labels exist."""
    if session_labels is None:
        return await _claude_native_bridge_id_for_session(
            server_client=server_client,
            session_id=session_id,
        )
    return await _claude_native_bridge_id_for_session(
        server_client=server_client,
        session_id=session_id,
        session_labels=session_labels,
    )


def _typed_spawn_env(value: object) -> dict[str, str]:
    """Validate a dynamically resolved native spawn-env hook result."""
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) and isinstance(item, str) for key, item in value.items()
    ):
        raise TypeError("native spawn-env builder must return a string mapping")
    return dict(value)


async def _resolve_native_spawn_env(
    harness_name: str,
    session_id: str,
    *,
    server_client: httpx.AsyncClient,
    optional_labels: Mapping[str, str] | None,
) -> dict[str, str] | None:
    """Build the spawn env for a native harness through the provider seam.

    Replaces the per-harness ``if harness_name == "<x>-native"`` spawn-env
    dispatch: resolves the harness's ``spawn_env_builder`` from the registry and
    supplies the bridge id the way that harness needs it.

    Three shapes: *bare* builders take only the session id; *label* builders
    (codex) take ``bridge_id=`` read from a session label named by
    ``provider.bridge_id_label_key``; and claude (bridge id via a runner helper
    with a server-side fallback).

    :param harness_name: Harness id, e.g. ``"codex-native"``.
    :param session_id: Omnigent conversation id.
    :param server_client: Runner's client to the Omnigent server, for label reads.
    :param optional_labels: Envelope labels already in hand, preferred over a
        fresh fetch for every label-backed native provider, or ``None``.
    :returns: The spawn env mapping, or ``None`` when *harness_name* is not a
        native harness with a registered spawn-env builder (caller keeps its
        existing ``spawn_env``).
    """
    agent = native_coding_agent_for_harness(harness_name)
    if agent is None:
        return None
    provider = native_provider_for_key(agent.key)
    if provider is None or provider.spawn_env_builder is None:
        return None
    builder = resolve_hook(provider, "spawn_env_builder")
    if builder is None:
        return None

    if agent.key == "claude":
        bridge_id = await _claude_native_bridge_id_with_optional_labels(
            server_client=server_client,
            session_id=session_id,
            session_labels=optional_labels,
        )
        return _typed_spawn_env(builder(session_id, bridge_id=bridge_id))

    if provider.bridge_id_label_key is not None:
        labels = (
            optional_labels
            if optional_labels is not None
            else await _session_labels_for_runner_spawn(
                server_client=server_client,
                session_id=session_id,
            )
            or {}
        )
        return _typed_spawn_env(
            builder(session_id, bridge_id=labels.get(provider.bridge_id_label_key))
        )

    return _typed_spawn_env(builder(session_id))


@dataclasses.dataclass(frozen=True)
class NativeLaunchContext:
    """Inputs a native harness's terminal builder may need at launch.

    One flat context passed to every ``_launch_<x>`` adapter so the launch
    dispatch can be uniform. Each adapter reads only the subset its
    ``_auto_create_<x>_terminal`` builder accepts; fields it doesn't use stay at
    their defaults. The claude-only callables (``auth_token_factory`` etc.) are
    per-session closures built by the runner and carried here rather than
    decomposed, since claude's adapter is their only reader.
    """

    session_id: str
    resource_registry: SessionResourceRegistry
    publish_event: Callable[[str, _JsonObject], None]
    server_client: httpx.AsyncClient | None = None
    event_dispatcher: RunnerEventDispatcher | None = None
    ensure_comment_relay: _EnsureCommentRelay | None = None
    agent_spec: AgentSpec | ResolvedSpec | None = None
    bundle_dir: Path | None = None
    skills_filter: str | list[str] = "all"
    agent_name: str | None = None
    session_init: RunnerSessionInitEnvelope | None = None
    auth_token_factory: Callable[[], str | None] | None = None
    resolve_launch_config: Callable[[], Awaitable[ClaudeNativeUcodeConfig | None]] | None = None
    record_launch_config: Callable[[str, ClaudeNativeUcodeConfig | None], None] | None = None


@dataclasses.dataclass(frozen=True)
class PreLaunchResult:
    """Outcome of a harness-specific pre-launch check (see the special arms).

    :param skip: When ``True``, do not auto-create (e.g. a sibling session's
        terminal is transferring in).
    :param force_recreate: When ``True``, tear down the session's terminals
        (``cleanup_conversation``, which is session-wide, not just this harness's
        terminal) and recreate — e.g. claude rebuild after an in-place agent
        switch. Mirrors the original claude arm's teardown scope.
    :param needs_terminal: When ``False``, skip auto-create because the session
        snapshot said a runner terminal is not needed (codex).
    """

    skip: bool = False
    force_recreate: bool = False
    needs_terminal: bool = True


async def _launch_pi(ctx: NativeLaunchContext) -> SessionResourceView:
    """Adapter: build the pi-native terminal from a launch context."""
    return await _auto_create_pi_terminal(
        ctx.session_id,
        ctx.resource_registry,
        ctx.publish_event,
        server_client=ctx.server_client,
        agent_spec=ctx.agent_spec,
        ensure_comment_relay=ctx.ensure_comment_relay,
    )


async def _launch_codex(ctx: NativeLaunchContext) -> SessionResourceView:
    """Adapter: build the codex-native terminal from a launch context."""
    return await _auto_create_codex_terminal(
        ctx.session_id,
        ctx.resource_registry,
        ctx.publish_event,
        bundle_dir=ctx.bundle_dir,
        skills_filter=ctx.skills_filter,
        agent_spec=ctx.agent_spec,
        server_client=ctx.server_client,
        ensure_comment_relay=ctx.ensure_comment_relay,
    )


async def _launch_claude(ctx: NativeLaunchContext) -> SessionResourceView:
    """Adapter: build the claude-native terminal from a launch context.

    ``server_client`` is required by the builder; the claude launch arm always
    binds one. Raise explicitly (rather than ``assert``, which ``-O`` strips) so
    a future caller that forgets gets a clear error instead of a ``None`` deref.
    """
    if ctx.server_client is None:
        raise ValueError("claude-native launch requires a bound server_client")
    return await _auto_create_claude_terminal(
        ctx.session_id,
        ctx.resource_registry,
        ctx.publish_event,
        server_client=ctx.server_client,
        event_dispatcher=ctx.event_dispatcher,
        bundle_dir=ctx.bundle_dir,
        agent_name=ctx.agent_name,
        agent_spec=ctx.agent_spec,
        skills_filter=ctx.skills_filter,
        session_init=ctx.session_init,
        auth_token_factory=ctx.auth_token_factory,
        resolve_launch_config=ctx.resolve_launch_config,
        record_launch_config=ctx.record_launch_config,
    )


async def _launch_native_terminal(
    harness_name: str,
    ctx: NativeLaunchContext,
    *,
    ensure_locks: MutableMapping[str, asyncio.Lock],
    pre_launch: Callable[[bool], Awaitable[PreLaunchResult]] | None = None,
    resolve_agent_spec: (Callable[[], Awaitable[AgentSpec | ResolvedSpec | None]] | None) = None,
    build_context: Callable[[NativeLaunchContext], Awaitable[NativeLaunchContext]] | None = None,
) -> bool | None:
    """Auto-create a native harness terminal through the provider seam.

    Replaces the per-harness ``if harness_name == "<x>-native"`` launch arms:
    resolves ``provider.auto_create_terminal`` from the registry and runs the
    shared lock / existence-check / pending-event / error-event mechanics every
    arm shared.

    The special arms' ``has_terminal``-dependent pre-call checks (claude rebuild
    + transfer-inbound, codex needs-terminal) run in *pre_launch*,
    invoked inside the lock with the computed ``has_terminal`` so it sees the
    same state the inline arms did. Context enrichment that must happen only on
    create (claude's bundle_dir / agent_name / skills, codex's bundle_dir) runs
    in *build_context*; the simpler uniform arms use *resolve_agent_spec* to fill
    just ``agent_spec``. Both run inside the create block, so their work (and
    error semantics) is skipped when a terminal already exists.

    :param harness_name: Harness id, e.g. ``"pi-native"``.
    :param ctx: Launch inputs; the resolved adapter reads the subset it needs.
    :param ensure_locks: Per-harness ``{session_id: Lock}`` map owned by the
        runner (kept there so session cleanup can pop the lock by name).
    :param pre_launch: Optional async callback ``(has_terminal) -> PreLaunchResult``
        run inside the lock to decide skip / force_recreate / needs_terminal.
    :param resolve_agent_spec: Optional async callback that resolves the session
        agent spec, invoked once inside the create block; the result replaces
        ``ctx.agent_spec``. Its exceptions surface as terminal-start errors (a
        resolver that tolerates ``OmnigentError`` must swallow it and return
        ``None``). Mutually exclusive with *build_context*.
    :param build_context: Optional async callback that returns the fully enriched
        context, invoked once inside the create block (for arms that resolve more
        than ``agent_spec``). Mutually exclusive with *resolve_agent_spec*.
    :returns: ``True`` when a terminal exists or was created, ``False`` when
        creation failed or was skipped, or ``None`` when *harness_name* is not a
        native harness with a launch adapter (caller handles it another way).
    """
    agent = native_coding_agent_for_harness(harness_name)
    if agent is None:
        return None
    provider = native_provider_for_key(agent.key)
    if provider is None:
        return None

    lock = ensure_locks.setdefault(ctx.session_id, asyncio.Lock())
    async with lock:
        registry = ctx.resource_registry.terminal_registry
        has_terminal = (
            registry is not None
            and registry.get(ctx.session_id, agent.terminal_name, "main") is not None
        )
        decision = await pre_launch(has_terminal) if pre_launch is not None else PreLaunchResult()
        if has_terminal and decision.force_recreate:
            if registry is not None:
                await registry.cleanup_conversation(ctx.session_id)
            has_terminal = False
        if has_terminal:
            return True
        if decision.skip or not decision.needs_terminal:
            return False

        adapter = resolve_hook(provider, "auto_create_terminal")
        if adapter is None:
            return None
        _publish_terminal_pending(ctx.publish_event, ctx.session_id, True)
        try:
            if build_context is not None:
                ctx = await build_context(ctx)
            elif resolve_agent_spec is not None:
                ctx = dataclasses.replace(ctx, agent_spec=await resolve_agent_spec())
            _logger.info(
                "Native input startup",
                extra=debug_event(
                    "native_input_starting",
                    session_id=ctx.session_id,
                    harness=harness_name,
                    stage="native_input",
                ),
            )
            await adapter(ctx)
            _logger.info(
                "Native terminal started",
                extra=debug_event(
                    "terminal_started",
                    session_id=ctx.session_id,
                    harness=harness_name,
                    stage="terminal_start",
                ),
            )
            return True
        except Exception as exc:
            _logger.exception(
                "Failed to auto-create %s terminal for %s",
                agent.terminal_name,
                ctx.session_id,
                extra=debug_event(
                    "terminal_start_failed",
                    session_id=ctx.session_id,
                    harness=harness_name,
                    stage="terminal_start",
                    error_impact=ErrorImpact.BLOCKING.value,
                    error_phase=ErrorPhase.HARNESS_STARTUP.value,
                ),
            )
            _publish_native_terminal_start_error(
                ctx.publish_event,
                ctx.session_id,
                agent.display_name,
                exc,
            )
            return False
        finally:
            _publish_terminal_pending(ctx.publish_event, ctx.session_id, False)


def _ensure_native_terminal_default_response(view: SessionResourceView) -> JSONResponse:
    """Default 200 response for the ensure path: the terminal view as-is."""
    return JSONResponse(status_code=200, content=session_resource_view_to_dict(view))


async def _ensure_native_terminal(
    terminal_name: str,
    ctx: NativeLaunchContext,
    *,
    ensure_locks: MutableMapping[str, asyncio.Lock],
    build_context: Callable[[NativeLaunchContext], Awaitable[NativeLaunchContext]] | None = None,
    is_owned: Callable[[SessionResourceRegistry, SessionResourceView], bool] | None = None,
    conflict_message: str | None = None,
    finalize: Callable[[SessionResourceView], JSONResponse] | None = None,
) -> JSONResponse | None:
    """Ensure a native harness terminal exists, returning its resource response.

    The terminal-ensure (attach / reattach) sibling of
    :func:`_launch_native_terminal`. Replaces the per-harness ``if terminal_name
    == "<x>" and session_key == "main"`` arms in ``create_session_terminal``:
    resolves ``provider.auto_create_terminal`` from the registry and runs the
    shared lock / view-based existence-check / error-response mechanics every arm
    shared.

    Unlike the launch shell this is a *view-based* path — the existence check
    returns the live :class:`SessionResourceView` (not a bool), the result is a
    :class:`JSONResponse` (200 with the view, 500 on builder failure, 409 on an
    ownership conflict), and it does NOT publish ``terminal_pending`` events.

    The codex ownership check (``is_owned``) and codex's one-shot
    policy-notice wrap (``finalize``) run inside the lock, matching the inline
    arms: codex's read-and-clear of the policy notice is only one-shot because
    the per-session lock serializes concurrent ensures.

    :param terminal_name: Short terminal name, e.g. ``"claude"`` (NOT
        ``"claude-native"``).
    :param ctx: Launch inputs; the resolved adapter reads the subset it needs.
    :param ensure_locks: Per-harness ``{session_id: Lock}`` map owned by the
        runner (the same map the launch shell uses).
    :param build_context: Optional async callback returning the enriched context,
        invoked once inside the create block (claude/codex/pi that
        resolve an agent spec). Its exceptions surface as terminal-start errors.
    :param is_owned: Optional predicate ``(registry, existing) -> bool`` deciding
        whether an existing terminal is the runner-owned native TUI. When it
        returns ``False`` the stale terminal is closed and replaced; a
        close failure returns 409 with ``conflict_message``.
    :param conflict_message: 409 detail used when a non-owned terminal cannot be
        closed. Required when ``is_owned`` is set.
    :param finalize: Optional ``(view) -> JSONResponse`` to build the success
        response (codex attaches its one-shot policy notice); defaults to a plain
        200 with the view.
    :returns: A :class:`JSONResponse`, or ``None`` when *terminal_name* is not a
        native harness with a launch adapter (caller falls through to the generic
        terminal launch path).
    """
    agent = native_coding_agent_for_terminal_name(terminal_name)
    if agent is None:
        return None
    provider = native_provider_for_key(agent.key)
    if provider is None:
        return None
    respond = finalize or _ensure_native_terminal_default_response

    terminal_id = terminal_resource_id(terminal_name, "main")
    lock = ensure_locks.setdefault(ctx.session_id, asyncio.Lock())
    async with lock:
        existing = await ctx.resource_registry.get_terminal_resource(ctx.session_id, terminal_id)
        if existing is not None:
            if is_owned is None or is_owned(ctx.resource_registry, existing):
                _logger.info(
                    "%s terminal ensure returning existing resource: session=%s terminal_id=%s",
                    agent.display_name,
                    ctx.session_id,
                    terminal_id,
                    extra={"session_id": ctx.session_id},
                )
                return respond(existing)
            _logger.info(
                "Replacing non-native %s terminal %s for session %s",
                terminal_name,
                terminal_id,
                ctx.session_id,
            )
            closed = await ctx.resource_registry.close_terminal(ctx.session_id, terminal_id)
            if not closed:
                return JSONResponse(
                    status_code=409,
                    content={
                        "error": {
                            "code": "terminal_conflict",
                            "message": conflict_message
                            or "Existing terminal could not be closed.",
                        }
                    },
                )

        adapter = resolve_hook(provider, "auto_create_terminal")
        if adapter is None:
            return None
        try:
            if build_context is not None:
                ctx = await build_context(ctx)
            _logger.info(
                "Native input startup",
                extra=debug_event(
                    "native_input_starting",
                    session_id=ctx.session_id,
                    harness=agent.harness,
                    stage="native_input",
                ),
            )
            view = await adapter(ctx)
            _logger.info(
                "Native terminal started",
                extra=debug_event(
                    "terminal_started",
                    session_id=ctx.session_id,
                    terminal_name=terminal_name,
                    stage="terminal_start",
                ),
            )
        except Exception as exc:
            if isinstance(exc, OmnigentError) and exc.code == ErrorCode.SESSION_AGENT_MISSING:
                # Expected lifecycle event (agent deleted/rebound), not an
                # ensure defect: log without a stack so it stays out of the
                # terminal-startup error signal.
                _logger.warning(
                    "%s terminal ensure skipped; session %s agent unavailable: %s",
                    agent.display_name,
                    ctx.session_id,
                    exc,
                    extra={"session_id": ctx.session_id},
                )
            else:
                _logger.exception(
                    "%s terminal ensure failed for session=%s",
                    agent.display_name,
                    ctx.session_id,
                    extra=debug_event(
                        "terminal_start_failed",
                        session_id=ctx.session_id,
                        terminal_name=terminal_name,
                        stage="terminal_start",
                        error_impact=ErrorImpact.BLOCKING.value,
                    ),
                )
            return _native_terminal_start_error_response(
                exc, agent.display_name, session_id=ctx.session_id
            )
        return respond(view)


async def _claude_native_session_wants_rebuild(
    server_client: httpx.AsyncClient | None,
    session_id: str,
    session_init: RunnerSessionInitEnvelope | None = None,
) -> bool:
    """
    Return whether a claude-native session is pending a post-switch rebuild.

    An in-place agent switch into claude-native clears the session's
    ``external_session_id`` and stamps the carry-history label, so the next
    launch must re-synthesize the Claude transcript from the CURRENT AP items.
    But when the session was ALREADY claude-native before the switch, its
    original terminal can still be registered (an open terminal tab keeps it
    alive). The auto-create that performs the re-synthesis is skipped while a
    terminal exists, so the switched-back agent keeps its original on-disk
    transcript — missing the turns added on the other agent. Detecting this
    lets the caller tear the stale terminal down first. A normal resume
    (``external_session_id`` already set) returns ``False`` so its terminal is
    left untouched.

    :param server_client: AP client; ``None`` can't confirm, returns ``False``.
    :param session_id: Session/conversation id, e.g. ``"conv_abc123"``.
    :param session_init: Versioned server snapshot. ``None`` selects the
        legacy session callback.
    :returns: ``True`` when ``external_session_id`` is unset AND the
        carry-history label is set (a pending rebuild), else ``False``.
    """
    if server_client is None:
        return False
    from omnigent.stores.conversation_store import FORK_CARRY_HISTORY_LABEL_KEY

    if session_init is not None:
        return (
            session_init.snapshot.external_session_id is None
            and session_init.snapshot.labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1"
        )

    try:
        resp = await server_client.get(
            f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}",
            params=_SESSION_METADATA_PARAMS,
            timeout=10.0,
        )
    except httpx.HTTPError:
        return False
    if resp.status_code != 200:
        return False
    snap = resp.json()
    # A captured native session means this is a normal resume, not a switch.
    if snap.get("external_session_id"):
        return False
    labels = snap.get("labels")
    return isinstance(labels, dict) and labels.get(FORK_CARRY_HISTORY_LABEL_KEY) == "1"


async def _claude_native_terminal_arrives_via_transfer(
    *,
    server_client: httpx.AsyncClient | None,
    session_id: str,
    resource_registry: SessionResourceRegistry,
    session_labels: Mapping[str, str] | None = None,
) -> bool:
    """
    Return whether a live Claude terminal will be transferred into a session.

    A ``/clear`` / ``/fork`` rotation binds the runner to a fresh session
    before transferring the existing terminal onto it; auto-creating a
    second Claude here would 409 the transfer and loop the rotation
    (rotation loop). The shared-bridge ``active_session_id`` still names the
    live terminal-owning session at bind time, detected here so the
    caller skips auto-create and lets the transfer deliver the terminal.

    :param server_client: Omnigent client to resolve the bridge id label;
        ``None`` can't confirm a rotation, so returns ``False``.
    :param session_id: Newly-bound session id, e.g. ``"conv_new"``.
    :param resource_registry: Registry probed for the original session's
        live ``claude:main`` terminal.
    :param session_labels: Labels supplied by the initialization envelope.
        ``None`` selects the legacy labels callback.
    :returns: ``True`` when a different session on the same bridge owns a
        live ``claude:main`` terminal (transfer inbound), else ``False``.
    """
    terminal_registry = resource_registry.terminal_registry
    if terminal_registry is None or server_client is None:
        return False
    # Lazy import keeps claude-native out of the generic runner import graph.
    from omnigent.harnesses.claude_native.bridge import (
        bridge_dir_for_bridge_id,
        read_active_session_id,
    )

    bridge_id = await _claude_native_bridge_id_with_optional_labels(
        server_client=server_client,
        session_id=session_id,
        session_labels=session_labels,
    )
    active_session_id = read_active_session_id(bridge_dir_for_bridge_id(bridge_id))
    # Fresh bridge, or the new session is already active — nothing transfers in.
    if active_session_id is None or active_session_id == session_id:
        return False
    return terminal_registry.get(active_session_id, "claude", "main") is not None


async def _codex_native_terminal_arrives_via_transfer(
    *,
    server_client: httpx.AsyncClient | None,
    session_id: str,
    resource_registry: SessionResourceRegistry,
    session_labels: Mapping[str, str] | None = None,
) -> bool:
    """
    Return whether a live Codex terminal will be transferred into a session.

    A native ``/new`` starts a fresh Codex thread in the SAME terminal, and the
    forwarder rotates ownership onto a fresh session before transferring
    that terminal onto it. Binding the runner to the new session triggers
    auto-create, and a second ``codex:main`` makes the rotation's transfer
    409 — leaving the terminal (and its tmux status link) owned by the old
    session while the web session streams from the new one. The shared
    bridge state still names the terminal-owning session at bind time
    (rotation rewrites it only AFTER the transfer), detected here so the
    caller skips auto-create and lets the transfer deliver the terminal.

    :param server_client: Omnigent client to resolve the bridge id label;
        ``None`` can't confirm a rotation, so returns ``False``.
    :param session_id: Newly-bound session id, e.g. ``"conv_new"``.
    :param resource_registry: Registry probed for the original session's
        live ``codex:main`` terminal.
    :param session_labels: Labels supplied by the initialization envelope.
        ``None`` selects the legacy labels callback.
    :returns: ``True`` when a different session on the same bridge owns a
        live ``codex:main`` terminal (transfer inbound), else ``False``.
    """
    terminal_registry = resource_registry.terminal_registry
    if terminal_registry is None:
        return False
    # Lazy import keeps codex-native out of the generic runner import graph.
    from omnigent.harnesses.codex_native.bridge import (
        CODEX_NATIVE_BRIDGE_ID_LABEL_KEY,
    )
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_bridge_id as codex_bridge_dir_for_bridge_id,
    )
    from omnigent.harnesses.codex_native.bridge import (
        read_bridge_state as read_codex_bridge_state,
    )

    if session_labels is not None:
        labels = session_labels
    elif server_client is not None:
        labels = (
            await _session_labels_for_runner_spawn(
                server_client=server_client,
                session_id=session_id,
            )
            or {}
        )
    else:
        return False
    bridge_id = labels.get(CODEX_NATIVE_BRIDGE_ID_LABEL_KEY) or session_id
    state = read_codex_bridge_state(codex_bridge_dir_for_bridge_id(bridge_id))
    # Fresh bridge, or the new session is already active — nothing transfers in.
    if state is None or state.session_id == session_id:
        return False
    return terminal_registry.get(state.session_id, "codex", "main") is not None


_SESSION_LABEL_LOOKUP_TIMEOUT_SECONDS = 1.0


async def _session_labels_for_runner_spawn(
    *,
    server_client: httpx.AsyncClient,
    session_id: str,
) -> dict[str, str] | None:
    """
    Fetch session labels for harness spawn-env construction.

    :param server_client: Omnigent server client used to fetch the session
        labels endpoint.
    :param session_id: Omnigent session/conversation id, e.g.
        ``"conv_abc123"``.
    :returns: String label mapping, or ``None`` on lookup failure.
        ``None`` is distinct from a confirmed-empty ``{}`` (a session that
        really carries no labels) — callers that cache this result must
        never cache ``None``, or a transient failure permanently poisons
        the cache as "no labels" (e.g. reading a side chat / superside-chat
        session as a plain one for the runner's lifetime).
    """
    path = f"/v1/sessions/{urllib.parse.quote(session_id, safe='')}/labels"
    try:
        resp = await server_client.get(
            path,
            timeout=_SESSION_LABEL_LOOKUP_TIMEOUT_SECONDS,
        )
    except httpx.TimeoutException as exc:
        _logger.debug(
            "Timed out resolving session labels; session=%s error=%s",
            session_id,
            type(exc).__name__,
            extra={"session_id": session_id},
        )
        return None
    except httpx.HTTPError as exc:
        _logger.warning(
            "Failed to resolve session labels; session=%s error=%s",
            session_id,
            type(exc).__name__,
            extra={"session_id": session_id},
        )
        return None
    if resp.status_code != 200:
        _logger.warning(
            "Failed to resolve session labels; session=%s status=%s",
            session_id,
            resp.status_code,
            extra={"session_id": session_id},
        )
        return None
    try:
        labels = resp.json().get("labels")
    except ValueError:
        # A 200 with a non-JSON body (e.g. an empty response from the
        # Databricks Apps proxy when the server event loop is starved,
        # or an HTML login page on an auth edge) must not abort the
        # turn. Labels are a best-effort spawn hint; recover by using
        # the session id, exactly as the timeout / non-200 paths do.
        _logger.warning(
            "Session labels response was not valid JSON; session=%s status=%s",
            session_id,
            resp.status_code,
            extra={"session_id": session_id},
        )
        return None
    if not isinstance(labels, dict):
        return {}
    return {str(key): str(value) for key, value in labels.items()}


@dataclasses.dataclass
class ResolvedSpec:
    spec: AgentSpec
    workdir: Path | None

    def __getattr__(self, name: str) -> Any:  # type: ignore[explicit-any]
        """Delegate compatibility attributes to the wrapped agent spec."""
        return getattr(self.spec, name)


def _unwrap_resolved_spec(entry: object) -> Any:  # type: ignore[explicit-any]
    """Unwrap cached specs without rejecting legacy or test resolver objects."""
    return entry.spec if isinstance(entry, ResolvedSpec) else entry


def _is_safe_bundle_segment(segment: Any) -> bool:
    """Return whether *segment* is a single, relative path component.

    Component check, not substring rejection: a directory legitimately
    named ``review..worker`` is one component and stays valid, while
    ``..``, ``a/b`` and absolute paths do not.
    """
    if not isinstance(segment, str) or not segment or segment in (".", ".."):
        return False
    try:
        candidate = Path(segment)
    except (TypeError, ValueError):
        return False
    return candidate.parts == (segment,) and not candidate.is_absolute()


def _sub_agent_bundle_segments(root: Any, child: Any) -> list[str] | None:
    """Identity-walk *child* up to *root*, collecting its bundle dir names.

    Returns ``None`` when the child is not reachable from the root by
    identity (synthetic / in-memory specs)
    or when any hop lacks a usable ``source_rel_dir``.
    """
    parents: dict[int, Any] = {}
    stack: list[Any] = [root]
    while stack:
        node = stack.pop()
        for sub in getattr(node, "sub_agents", None) or []:
            parents[id(sub)] = node
            stack.append(sub)
    segments: list[str] = []
    current = child
    while current is not root:
        parent = parents.get(id(current))
        if parent is None:
            return None
        segment = getattr(current, "source_rel_dir", None)
        if not _is_safe_bundle_segment(segment):
            return None
        segments.append(str(segment))
        current = parent
    segments.reverse()
    return segments


def _sub_agent_bundle_workdir(parent_entry: Any, parent_spec: Any, child_spec: Any) -> Path | None:
    """Compose ``<parent workdir>/agents/<dir>`` per hop down to *child_spec*."""
    parent_workdir = _resolved_spec_workdir(parent_entry)
    if parent_workdir is None:
        return None
    segments = _sub_agent_bundle_segments(parent_spec, child_spec)
    if segments is None:
        return None
    workdir = parent_workdir
    for segment in segments:
        workdir = workdir / "agents" / segment
    return workdir if workdir.is_dir() else None


def _resolve_sub_agent_spec_entry(parent_entry: Any, sub_agent_name: str) -> ResolvedSpec | None:
    """Resolve a sub-agent by name into a spec entry rooted at its own bundle dir.

    The returned entry is always wrapped so downstream workdir lookups see
    the child's own directory (or ``None``) — never the parent's bundle
    root, which would expose the parent's skills and local tools to the
    child.

    :param parent_entry: Parent spec, bare or wrapped in ``ResolvedSpec``.
    :param sub_agent_name: Name of the sub-agent to resolve.
    :returns: The wrapped child entry, or ``None`` when the name does not
        resolve.
    """
    from omnigent.runtime.workflow import _find_spec_by_name

    parent_spec = _unwrap_resolved_spec(parent_entry)
    if (
        isinstance(parent_entry, ResolvedSpec)
        and getattr(parent_spec, "name", None) == sub_agent_name
    ):
        # Already the child: the session cache holds the resolved entry, and sub-agent
        # names are unique across the tree, so resolving again is a no-op. (The tree
        # search never matches its own root, so this would otherwise be a spurious miss.)
        return parent_entry
    child_spec = _find_spec_by_name(parent_spec, sub_agent_name)
    if child_spec is None:
        # Callers in runtime/workflow.py keep the parent spec on a lookup
        # miss, which boots the child as a clone of the parent. Unsafe, but
        # pre-existing and out of scope here — tracked separately.
        _logger.warning(
            "Sub-agent %r not found under spec %r; no workdir resolved",
            sub_agent_name,
            getattr(parent_spec, "name", None),
            extra={"session_id": runner_primary_session_id()},
        )
        return None
    return ResolvedSpec(
        spec=child_spec,
        workdir=_sub_agent_bundle_workdir(parent_entry, parent_spec, child_spec),
    )


def _forward_harness_response(resp: httpx.Response) -> Response:
    """Relay a non-streaming harness response through FastAPI."""
    if resp.status_code in _NO_BODY_STATUS_CODES:
        return Response(status_code=resp.status_code)
    content_type = resp.headers.get("content-type", "")
    if not resp.content:
        return Response(content=b"", status_code=resp.status_code, media_type=content_type or None)
    if "application/json" in content_type.lower():
        try:
            return JSONResponse(status_code=resp.status_code, content=resp.json())
        except ValueError:
            pass
    return Response(
        content=resp.content, status_code=resp.status_code, media_type=content_type or None
    )


def _resolved_spec_workdir(entry: object) -> Path | None:
    return entry.workdir if isinstance(entry, ResolvedSpec) else None


def _resolved_workdir_for_spec(
    spec: object,
    fallback: Path | None,
) -> Path | None:
    """Return the bundle workdir for a possibly wrapped spec entry."""
    if isinstance(spec, ResolvedSpec):
        return spec.workdir
    return fallback


def _rewrap_like(previous: object, spec: AgentSpec, workdir: Path | None) -> Any:  # type: ignore[explicit-any]
    """Re-wrap *spec* iff *previous* was wrapped, preserving a ``None`` workdir.

    A wrapped entry has a verdict on its bundle dir — including a sub-agent's
    ``None`` — and re-widening that to the runner workspace is the leak. A spec
    that never carried bundle information stays bare so it keeps the workspace
    fallback ordinary top-level sessions rely on.
    """
    return ResolvedSpec(spec=spec, workdir=workdir) if isinstance(previous, ResolvedSpec) else spec


def _is_spec_local_native_python_tool(
    spec: object,
    tool_name: str,
) -> bool:
    """Return whether *tool_name* is a spec-declared native python tool."""
    unwrapped = _unwrap_resolved_spec(spec)
    if unwrapped is None:
        return False
    return any(
        getattr(info, "name", None) == tool_name
        and getattr(info, "language", None) in ("python", "omnigent-python-callable")
        for info in getattr(unwrapped, "local_tools", [])
    )
