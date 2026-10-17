"""The Omnigent REPL terminal a runner hosts beside an SDK-harness session.

A top-level claude-sdk / pi session gets an auxiliary tmux terminal running
``omnigent attach`` so the web UI can embed the REPL as a secondary view.
"""

from __future__ import annotations

import logging
import os
import sys
import time
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

from omnigent.runner.resource_registry import OMNIGENT_REPL_TERMINAL_ROLE, SessionResourceRegistry
from omnigent.runner.spec_entries import ResolvedSpec
from omnigent.util.json_types import JsonObject as _JsonObject

if TYPE_CHECKING:
    from omnigent.entities.session_resources import SessionResourceView
    from omnigent.inner.datamodel import OSEnvSpec
    from omnigent.spec.types import AgentSpec

_logger = logging.getLogger(__name__)

REPL_TERMINAL_NAME = "tui"
REPL_TERMINAL_SESSION_KEY = "main"


def _runner_workspace_dir() -> str:
    """
    Resolve the runner's workspace for a runner-hosted terminal launch.

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
            "Cannot resolve a workspace for the terminal: "
            "OMNIGENT_RUNNER_WORKSPACE is unset and the runner's working "
            "directory no longer exists."
        ) from exc


def _agent_os_env_from_spec(
    agent_spec: AgentSpec | ResolvedSpec | None,
) -> OSEnvSpec | None:
    """
    Read the agent's ``os_env`` from a resolved agent spec.

    The auto-created REPL terminal must inherit the
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


def publish_terminal_pending(
    publish_event: Callable[[str, _JsonObject], None],
    session_id: str,
    pending: bool,
) -> None:
    """
    Publish a terminal spin-up status event onto the session stream.

    Emitted by the auto-create path so the web UI can show a spinner on
    the Terminal pill while the runner boots the session's terminal, and
    clear it once the terminal lands or auto-create
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


async def auto_create_repl_terminal(
    session_id: str,
    resource_registry: SessionResourceRegistry,
    publish_event: Callable[[str, _JsonObject], None],
    *,
    server_client: httpx.AsyncClient,
    agent_spec: AgentSpec | ResolvedSpec | None = None,
) -> SessionResourceView:
    """
    Auto-create an Omnigent REPL terminal for a runner-hosted SDK session.

    Called when the runner receives a top-level SDK-harness session via
    ``POST /v1/sessions`` and no REPL terminal exists yet. The terminal
    hosts the framework's own TUI (``omnigent attach <session_id> --server
    <url>``) in a tmux pane, exposed through the standard terminal-attach
    WebSocket so the web UI can embed it.

    The REPL is a pure co-drive client: it joins the live session over
    HTTP+SSE and dispatches turns to this runner, so the web chat view and
    the embedded terminal stay in sync. The tmux command is deferred until
    the first client attaches (``tmux_start_on_attach``): a session whose
    terminal is never opened pays only for an idle tmux pane, and by first
    attach the session is fully live (``omnigent attach`` fails loud on a
    non-live session) with the REPL sized to the real attached terminal.

    The spawned ``omnigent attach`` resolves credentials for ``--server`` the same way a
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
    # container.
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
        terminal_name=REPL_TERMINAL_NAME,
        session_key=REPL_TERMINAL_SESSION_KEY,
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
    # launch helper registers the resource but does not publish).
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
