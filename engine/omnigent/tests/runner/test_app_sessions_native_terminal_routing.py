"""Tests for native terminal ensure routing and REPL terminal creation."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest

from omnigent.entities.session_resources import SessionResourceView
from omnigent.inner.terminal import TerminalInstance
from omnigent.runner.repl_terminal import auto_create_repl_terminal
from omnigent.spec.types import AgentSpec, ExecutorSpec
from omnigent.terminals import TerminalRegistry


@dataclass
class _EnsureTerminalCase:
    """
    One routing case for the claude-native ``create_session_terminal``
    ensure-path branch.

    :param case_id: Human-readable id for the parametrize label.
    :param body: The ``POST /resources/terminals`` JSON body.
    :param existing: Whether a live ``claude``/``main`` terminal already
        exists (drives the stubbed ``get_terminal_resource``).
    :param expect_auto_create: Whether the request must route to
        ``_auto_create_claude_terminal`` (the ensure path).
    :param expect_launch: Whether the request must route to the generic
        terminal launch path instead.
    :param expect_name: ``name`` of the resource the route must return —
        identifies which collaborator produced the response.
    """

    case_id: str
    body: dict[str, object]
    existing: bool
    expect_auto_create: bool
    expect_launch: bool
    expect_name: str


@dataclass
class _RecordedPatch:
    """
    A PATCH captured from the REPL terminal auto-create helper.

    :param url: Request path, e.g. ``"/v1/sessions/11c50cd73e9c32ccb0af5b9db291db8b"``.
    :param json: JSON body, e.g. ``{"labels": {"omnigent.ui": "terminal"}}``.
    """

    url: str
    json: dict[str, Any]


@pytest.mark.asyncio
async def test_auto_create_repl_terminal_inherits_agent_sandbox(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    The REPL terminal honours the agent's ``os_env.sandbox``.

    Regression for the same sandbox-override bug #175 fixed on the
    codex/claude auto-create paths but missed on the REPL path: the
    REPL auto-create built a fresh ``TerminalEnvSpec`` whose ``os_env``
    carried no ``sandbox`` and passed no ``parent_os_env``, so
    ``launch_terminal`` fell back to ``_default_sandbox_for_platform``
    (``linux_bwrap`` / ``darwin_seatbelt``) and ignored the agent YAML.
    An SDK-harness agent that declares ``os_env.sandbox.type: none``
    (relying on the outer container/VM as the boundary) was wrongly
    forced into bwrap, which then failed to start in a hardened
    container with ``native_terminal_start_failed``.

    Asserts the launched terminal spec's ``os_env.sandbox`` is the
    agent's ``none`` sandbox (not the platform default) and that the
    agent's ``os_env`` is threaded through as the launch
    ``parent_os_env`` so the rest of the policy is inherited too.

    :param tmp_path: Temporary directory for the fake runner workspace.
    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: None.
    """
    from omnigent.inner.datamodel import OSEnvSandboxSpec, OSEnvSpec

    session_id = "f75bf7158ce8716ae3b934522271979c"
    workspace = tmp_path / "workspace"
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(workspace))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")

    captured: dict[str, Any] = {}

    class _FakeResourceRegistry:
        """Captures the launched REPL terminal spec and parent os_env."""

        async def launch_auxiliary_terminal(
            self,
            *,
            session_id: str,
            terminal_name: str,
            session_key: str,
            spec: Any,
            resource_role: str | None = None,
            parent_os_env: Any = None,
        ) -> SessionResourceView:
            """Record the spec + parent_os_env and return a resource view."""
            del terminal_name, session_key, resource_role
            captured["spec"] = spec
            captured["parent_os_env"] = parent_os_env
            return SessionResourceView(
                id="terminal_tui_main",
                type="terminal",
                session_id=session_id,
                name="tui",
            )

    class _PatchRecordingServerClient:
        """Server client that absorbs the label PATCH from the helper."""

        async def patch(self, url: str, **kwargs: Any) -> httpx.Response:
            """Return a 200 for the presentation-label PATCH."""
            del kwargs
            return httpx.Response(200, json={}, request=httpx.Request("PATCH", url))

    # An agent that declares sandbox: none (runs unconfined; the outer
    # container/VM is the boundary).
    agent_os_env = OSEnvSpec(
        type="caller_process",
        cwd=".",
        sandbox=OSEnvSandboxSpec(type="none"),
    )
    agent_spec = AgentSpec(
        spec_version=1,
        name="sdk_worker",
        executor=ExecutorSpec(
            type="omnigent",
            config={"harness": "claude-sdk", "model": "claude-default"},
        ),
        os_env=agent_os_env,
    )

    await auto_create_repl_terminal(
        session_id,
        _FakeResourceRegistry(),  # type: ignore[arg-type]
        lambda _sid, _evt: None,
        server_client=_PatchRecordingServerClient(),  # type: ignore[arg-type]
        agent_spec=agent_spec,
    )

    launched_sandbox = captured["spec"].os_env.sandbox
    assert launched_sandbox is not None, (
        "REPL auto-create dropped the agent's sandbox; launch_terminal will "
        "fall back to _default_sandbox_for_platform (bwrap), overriding "
        "sandbox: none"
    )
    assert launched_sandbox.type == "none"
    # The whole os_env is threaded through as the inheritance parent.
    assert captured["parent_os_env"] is agent_os_env


@pytest.mark.asyncio
async def test_dead_registered_pane_close_does_not_restore_running(
    tmp_path: Path,
) -> None:
    """A dead-pane close no longer mutates the advisory ``running`` flag.

    ``is_alive()`` sets ``instance.running = False`` as a side effect when
    the pane is dead. ``TerminalInstance.close()`` now uses the private socket
    to decide whether to issue ``tmux kill-server``, so the self-heal path does
    not need to falsify this liveness state before closing the stale entry.

    This test exercises the contract directly on ``TerminalRegistry.close``
    with a tracking ``close()`` stub that captures ``running`` at call time.

    :param tmp_path: Temporary directory fixture.
    :returns: None.
    """
    sid = "deadbeef12345678deadbeef12345678"
    registry = TerminalRegistry()
    dead_instance = TerminalInstance(
        name="claude",
        session_key="main",
        socket_path=tmp_path / "dead.sock",
        private_dir=tmp_path / "dead_private",
    )
    dead_instance.running = True
    (tmp_path / "dead_private").mkdir(exist_ok=True)

    async def _fake_is_alive() -> bool:
        dead_instance.running = False
        return False

    dead_instance.is_alive = _fake_is_alive  # type: ignore[assignment]

    running_at_close: list[bool] = []

    async def _tracking_close() -> None:
        running_at_close.append(dead_instance.running)

    dead_instance.close = _tracking_close  # type: ignore[assignment]

    with registry._lock:
        registry._by_conversation[sid] = {("claude", "main"): dead_instance}
        registry._instance_locks[(sid, "claude", "main")] = threading.Lock()

    alive = await dead_instance.is_alive()
    assert alive is False
    assert dead_instance.running is False, "is_alive() should set running=False"

    await registry.close(sid, "claude", "main")

    assert len(running_at_close) == 1, (
        f"Expected close() to be called once; got {len(running_at_close)} calls"
    )
    assert running_at_close[0] is False
    assert registry.get(sid, "claude", "main") is None, (
        "Stale entry must be removed from the registry"
    )
