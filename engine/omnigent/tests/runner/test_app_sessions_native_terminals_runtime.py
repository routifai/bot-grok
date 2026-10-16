"""Tests for Codex and Claude terminal runtime behavior."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shlex
import shutil
import threading
import uuid
from pathlib import Path
from typing import Any, cast

import httpx
import pytest

from omnigent.entities.session_resources import SessionResourceView
from omnigent.harnesses.claude_native import bridge as claude_native_bridge
from omnigent.harnesses.claude_native.bridge import (
    bridge_dir_for_bridge_id,
    prepare_bridge_dir,
)
from omnigent.harnesses.codex_native import bridge as codex_native_bridge
from omnigent.runner import create_runner_app
from omnigent.runner.app import (
    ResolvedSpec,
    _auto_create_codex_terminal,
)
from omnigent.runner.resource_registry import (
    CODEX_NATIVE_TERMINAL_ROLE,
    SessionResourceRegistry,
)
from omnigent.spec.types import AgentSpec, ExecutorSpec
from tests.runner.conftest import (
    _FakeProcessManager,
    _runner_client,
    _ScriptedHarnessClient,
    _sse,
)
from tests.runner.helpers import NullServerClient


@pytest.mark.asyncio
async def test_create_session_threads_workspace_to_pi_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pi pre-spawn receives the session workspace, not the bundle dir."""
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path / "config-home"))
    # Isolate $HOME too: ambient provider detection reads ~/.databrickscfg,
    # which on a multi-profile Databricks dev box otherwise 400s the create
    # with "match <host>; use --profile" (issue #4279).
    monkeypatch.setenv("HOME", str(tmp_path / "config-home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "config-home"))
    session_id = "18f39ab73f49285e4dab0c80ff7b8455"
    runner_workspace = tmp_path / "runner-workspace"
    runner_workspace.mkdir()
    bundle_dir = tmp_path / "runner-specs" / "86c64e0f9cab937bd04c79b9957dd55a-v1"
    bundle_dir.mkdir(parents=True)
    worktree = tmp_path / "repo-worktrees" / "feature-x"
    worktree.mkdir(parents=True)
    spec = AgentSpec(
        spec_version=1,
        name="pi-worktree-agent",
        skills_filter="none",
        executor=ExecutorSpec(config={"harness": "pi"}),
    )
    harness_client = _ScriptedHarnessClient([])
    pm = _FakeProcessManager(harness_client)

    async def _resolver(agent_id: str, session_id: str | None = None) -> ResolvedSpec:
        del agent_id, session_id
        return ResolvedSpec(spec=spec, workdir=bundle_dir)

    class _SessionWorkspaceClient(NullServerClient):
        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            del kwargs
            if url == f"/v1/sessions/{session_id}":
                return httpx.Response(
                    200,
                    json={
                        "id": session_id,
                        "agent_id": "86c64e0f9cab937bd04c79b9957dd55a",
                        "created_at": 1.0,
                        "workspace": str(worktree),
                    },
                    request=httpx.Request("GET", url),
                )
            return await super().get(url)

    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        spec_resolver=_resolver,
        server_client=_SessionWorkspaceClient(),  # type: ignore[arg-type]
        runner_workspace=runner_workspace,
    )

    async with _runner_client(app) as client:
        resp = await client.post(
            "/v1/sessions",
            json={"session_id": session_id, "agent_id": "86c64e0f9cab937bd04c79b9957dd55a"},
        )

    assert resp.status_code == 201
    assert pm.get_client_calls
    conversation_id, harness, env = pm.get_client_calls[-1]
    assert conversation_id == session_id
    assert harness == "pi"
    assert env is not None
    assert env["HARNESS_PI_CWD"] == str(worktree.resolve())
    assert env["HARNESS_PI_BUNDLE_DIR"] == str(bundle_dir)


@pytest.mark.parametrize("workspace_value", [None, "   "])
@pytest.mark.asyncio
async def test_create_session_threads_runner_workspace_to_pi_cwd_when_session_workspace_missing(
    workspace_value: str | None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pi pre-spawn falls back to runner workspace when session workspace is empty."""
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path / "config-home"))
    # Isolate $HOME too: ambient provider detection reads ~/.databrickscfg,
    # which on a multi-profile Databricks dev box otherwise 400s the create
    # with "match <host>; use --profile" (issue #4279).
    monkeypatch.setenv("HOME", str(tmp_path / "config-home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "config-home"))
    session_id = "3f1d20a97a7d0ba93e02cf17aeb92367"
    runner_workspace = tmp_path / "runner-workspace"
    runner_workspace.mkdir()
    bundle_dir = tmp_path / "runner-specs" / "86c64e0f9cab937bd04c79b9957dd55a-v1"
    bundle_dir.mkdir(parents=True)
    spec = AgentSpec(
        spec_version=1,
        name="pi-runner-workspace-agent",
        skills_filter="none",
        executor=ExecutorSpec(config={"harness": "pi"}),
    )
    harness_client = _ScriptedHarnessClient([])
    pm = _FakeProcessManager(harness_client)

    async def _resolver(agent_id: str, session_id: str | None = None) -> ResolvedSpec:
        del agent_id, session_id
        return ResolvedSpec(spec=spec, workdir=bundle_dir)

    class _SessionWorkspaceClient(NullServerClient):
        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            del kwargs
            if url == f"/v1/sessions/{session_id}":
                return httpx.Response(
                    200,
                    json={
                        "id": session_id,
                        "agent_id": "86c64e0f9cab937bd04c79b9957dd55a",
                        "created_at": 1.0,
                        "workspace": workspace_value,
                    },
                    request=httpx.Request("GET", url),
                )
            return await super().get(url)

    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        spec_resolver=_resolver,
        server_client=_SessionWorkspaceClient(),  # type: ignore[arg-type]
        runner_workspace=runner_workspace,
    )

    async with _runner_client(app) as client:
        resp = await client.post(
            "/v1/sessions",
            json={"session_id": session_id, "agent_id": "86c64e0f9cab937bd04c79b9957dd55a"},
        )

    assert resp.status_code == 201
    assert pm.get_client_calls
    conversation_id, harness, env = pm.get_client_calls[-1]
    assert conversation_id == session_id
    assert harness == "pi"
    assert env is not None
    assert env["HARNESS_PI_CWD"] == str(runner_workspace.resolve())
    assert env["HARNESS_PI_BUNDLE_DIR"] == str(bundle_dir)


@pytest.mark.parametrize(
    ("session_json", "expected"),
    [
        # Host-spawned (web UI): bound to a host -> auto-create.
        (
            {
                "id": "8af356d908005a65f872c246158c6293",
                "host_id": "abb32306b80732bdfa6153b2f5f6eb92",
            },
            True,
        ),
        # Top-level CLI session: no host_id and no parent, but the runner
        # still owns the Codex app-server and terminal.
        ({"id": "8af356d908005a65f872c246158c6293", "host_id": None}, True),
        ({"id": "8af356d908005a65f872c246158c6293"}, True),
    ],
)
@pytest.mark.asyncio
async def test_codex_top_level_session_needs_runner_terminal_for_all_session_shapes(
    session_json: dict[str, object], expected: bool
) -> None:
    """
    Codex-native terminal auto-create is runner-owned for every session.

    A top-level CLI session has no ``host_id`` and no parent, but the
    runner must still create the app-server and TUI terminal. If the old
    host-id gate returns ``False`` here, ``omnigent codex`` falls back to
    a CLI-owned app-server.
    """
    from omnigent.runner.app import _codex_session_needs_runner_terminal

    class _Client:
        async def get(
            self,
            url: str,
            *,
            timeout: float,
            params: dict[str, str] | None = None,
        ) -> httpx.Response:
            del timeout, params
            return httpx.Response(200, json=session_json, request=httpx.Request("GET", url))

    assert (
        await _codex_session_needs_runner_terminal(_Client(), "8af356d908005a65f872c246158c6293")
        is expected
    )


@pytest.mark.asyncio
async def test_auto_create_codex_terminal_keeps_loop_responsive_during_profile_resolution(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A blocking builder dependency must not stop the runner's event loop."""
    import omnigent.harnesses.codex_native.app_server as codex_app_mod

    loop = asyncio.get_running_loop()
    lookup_started = asyncio.Event()
    lookup_release = threading.Event()
    loop_progressed: list[bool] = []

    def resolve_host(profile: str | None) -> None:
        assert profile == "test-profile"
        loop.call_soon_threadsafe(lookup_started.set)
        loop_progressed.append(lookup_release.wait(timeout=1.0))

    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    monkeypatch.setattr(
        "omnigent.harnesses.codex_native.process_registry.reap_codex_native_processes_for_state_dir",
        lambda _bridge_dir: None,
    )
    monkeypatch.setattr(
        "omnigent.inner.codex_executor.populate_codex_skills_from_bundle",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr("omnigent.inner.codex_executor._find_codex_cli", lambda: "codex")
    monkeypatch.setattr(codex_app_mod, "_find_codex_cli", lambda: "codex")
    monkeypatch.setattr(codex_app_mod, "_clean_codex_env", dict)
    monkeypatch.setattr(codex_app_mod, "_databricks_gateway_host", resolve_host)
    monkeypatch.setattr(
        codex_app_mod,
        "resolve_native_codex_launch",
        lambda *, model, spec=None: codex_app_mod.NativeCodexLaunch([], model, "test-profile"),
    )

    task = asyncio.create_task(
        _auto_create_codex_terminal(
            uuid.uuid4().hex,
            cast(SessionResourceRegistry, object()),
            lambda _session_id, _event: None,
            server_client=cast(httpx.AsyncClient, NullServerClient()),
        )
    )
    try:
        await asyncio.wait_for(lookup_started.wait(), timeout=2.0)
        lookup_release.set()
        with pytest.raises(OSError, match="profile 'test-profile'"):
            await task
    finally:
        lookup_release.set()
        await asyncio.gather(task, return_exceptions=True)

    assert loop_progressed == [True], "profile resolution blocked the runner's event loop"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("version", "permission_args", "retain_subscription"),
    [
        ((0, 153, 1), ["--config", "approval_policy=on-request"], False),
        ((0, 154, 0), [], True),
        (None, [], True),
    ],
)
@pytest.mark.parametrize("cancel_launch", [False, True])
async def test_auto_create_codex_terminal_uses_persisted_resume_launch_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    version: tuple[int, int, int] | None,
    permission_args: list[str],
    retain_subscription: bool,
    cancel_launch: bool,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """
    Runner-owned Codex launch consumes persisted args and thread id.

    The CLI now persists launch intent and asks the runner to ensure the
    terminal. This test exercises the runner helper directly: it must read
    ``terminal_launch_args`` and ``external_session_id`` from the Omnigent snapshot,
    start the app-server itself, launch the TUI as ``codex ... resume
    --remote <runner-ws> <thread>``, and run the known-thread forwarder. If
    this regresses, the CLI falls back into split ownership or loses user
    pass-through flags on resume.

    :param tmp_path: Temporary directory for isolated bridge state.
    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: None.
    """
    import omnigent.harness_startup_config as startup_config_mod
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.runner import app as runner_app_mod

    session_id = "76cbdcbbf84d4149b2a7d7441b6966c1"
    thread_id = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    session_reap_calls: list[Path] = []
    monkeypatch.setattr(
        "omnigent.harnesses.codex_native.process_registry.reap_codex_native_processes_for_state_dir",
        lambda bridge_dir: session_reap_calls.append(bridge_dir),
    )
    caplog.set_level(logging.INFO, logger="omnigent.runner.app")
    caplog.set_level(logging.INFO, logger="omnigent.runner.native.orchestration")
    bridge_dir = codex_native_bridge.bridge_dir_for_bridge_id(session_id)
    codex_native_bridge.write_bridge_state(
        bridge_dir,
        codex_native_bridge.CodexNativeBridgeState(
            session_id=session_id,
            socket_path="ws://127.0.0.1:1",
            thread_id="019e96aa-1111-7222-8333-444455556666",
            codex_home=str(tmp_path / "stale-codex-home"),
        ),
    )

    class _SnapshotServerClient:
        """Server client that returns the persisted Codex launch config."""

        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            """
            Return the session snapshot consumed by the runner helper.

            :param url: Request path, e.g.
                ``"/v1/sessions/76cbdcbbf84d4149b2a7d7441b6966c1"``.
            :param kwargs: Request keyword arguments such as
                ``{"timeout": 10.0}`` or ``{"params": {"limit": 1000}}``.
            :returns: HTTP 200 response carrying launch config.
            """
            if url == f"/v1/sessions/{session_id}/items":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "b1649a5cbfec3f92bec12275c14f4b5f",
                                "response_id": "codex_turn_1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "remember this"}],
                            }
                        ],
                        "has_more": False,
                    },
                    request=httpx.Request("GET", url),
                )
            assert url == f"/v1/sessions/{session_id}", kwargs
            return httpx.Response(
                200,
                json={
                    "terminal_launch_args": [
                        "--config",
                        "approval_policy=on-request",
                    ],
                    "model_override": "gpt-5.4-mini",
                    "external_session_id": thread_id,
                },
                request=httpx.Request("GET", url),
            )

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version = version

        def __init__(self) -> None:
            """:returns: None."""
            self.env = {"OPENAI_API_KEY": "sk-test", "IGNORED": "nope"}
            self.codex_home = tmp_path / "unconfigured-codex-home"
            self.listen_url: str | None = None
            self.started = False
            self.closed = False
            # Provider/model -c overrides the runner forwards to the
            # --remote TUI; empty here (no profile in this test).
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """:returns: None."""
            assert list(self.codex_home.glob(f"sessions/**/rollout-*-{thread_id}.jsonl")), (
                "Codex resume rollout must be synthesized in app-server CODEX_HOME "
                "before app-server start"
            )
            self.started = True

        async def close(self) -> None:
            """:returns: None."""
            self.closed = True

    app_server = _FakeCodexAppServer()
    build_calls: list[dict[str, Any]] = []

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """
        Capture app-server construction.

        :param kwargs: Keyword arguments passed by the runner helper.
        :returns: Fake app-server.
        """
        assert session_reap_calls == [bridge_dir]
        build_calls.append(kwargs)
        app_server.codex_home = kwargs["codex_home"]
        return app_server

    class _UnexpectedDiscoveryClient:
        """
        App-server client that must not connect on a known-thread resume.

        Fresh sessions connect this listener to discover ``thread/started``.
        Resume sessions already have ``external_session_id`` and should go
        straight to the known-thread forwarder.
        """

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """
            :param ws_url: App-server WebSocket URL.
            :param client_name: JSON-RPC client name.
            """
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """
            Fail if the resume path tries to discover a fresh thread.

            :returns: None.
            """
            raise AssertionError("resume path must not connect discovery client")

        async def close(self) -> None:
            """:returns: None."""

    class _RetainedClient:
        closed = False

        async def close(self) -> None:
            self.closed = True

    retained_client = _RetainedClient()
    launched_specs: list[Any] = []

    class _FakeResourceRegistry:
        """Resource registry that records the launched terminal spec."""

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
            """
            Record the terminal launch request.

            :param session_id: Session id being launched.
            :param terminal_name: Terminal name, e.g. ``"codex"``.
            :param session_key: Terminal session key, e.g. ``"main"``.
            :param spec: Terminal launch spec.
            :param resource_role: Private runner resource marker.
            :returns: Terminal resource view.
            """
            assert session_id == "76cbdcbbf84d4149b2a7d7441b6966c1"
            assert terminal_name == "codex"
            assert session_key == "main"
            assert resource_role == CODEX_NATIVE_TERMINAL_ROLE
            assert not retained_client.closed
            preloaded_state = codex_native_bridge.read_bridge_state(bridge_dir)
            assert preloaded_state is not None
            assert preloaded_state.thread_id == thread_id
            launched_specs.append(spec)
            if cancel_launch:
                raise asyncio.CancelledError
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    published_events: list[dict[str, Any]] = []
    forward_calls: list[dict[str, Any]] = []
    preload_calls: list[tuple[str, str, list[str] | None]] = []

    async def _fake_preload_thread(
        transport: str,
        loaded_thread_id: str,
        *,
        terminal_launch_args: list[str] | None = None,
        retain_client: bool = False,
        cwd: Path | None = None,
    ) -> Any:
        """
        Record preloading of the known Codex thread.

        :param transport: App-server transport URL.
        :param loaded_thread_id: Thread id passed to ``thread/resume``.
        :returns: None.
        """
        assert codex_native_bridge.read_bridge_state(bridge_dir) is None, (
            "stale bridge state must be cleared until the new app-server has "
            "loaded the resume thread"
        )
        preload_calls.append((transport, loaded_thread_id, terminal_launch_args))
        assert isinstance(cwd, Path)
        assert retain_client is retain_subscription
        return retained_client if retain_client else None

    async def _fake_forward_known_thread(**kwargs: Any) -> None:
        """
        Record the known-thread forwarder invocation.

        :param kwargs: Forwarder keyword arguments.
        :returns: None.
        """
        forward_calls.append(kwargs)

    monkeypatch.setattr(
        codex_app_mod,
        "build_codex_native_server",
        _fake_build_codex_native_server,
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _UnexpectedDiscoveryClient)
    monkeypatch.setattr(codex_app_mod, "preload_codex_thread_for_resume", _fake_preload_thread)
    monkeypatch.setattr(runner_app_mod, "_codex_forward_known_thread", _fake_forward_known_thread)
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_config",
        lambda _cfg: (None, {"codex-native": {"command": "codex-wrapper"}}),
    )
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_args",
        lambda _harness, args, *, cfg: ["codex", "--", *args],
    )

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        instructions="Be a concise, careful coding assistant.",
        executor=ExecutorSpec(
            type="omnigent",
            config={"harness": "codex-native", "model": "gpt-5-default"},
        ),
    )

    try:
        if cancel_launch:
            with pytest.raises(asyncio.CancelledError):
                await _auto_create_codex_terminal(
                    session_id,
                    _FakeResourceRegistry(),  # type: ignore[arg-type]
                    lambda _sid, event: published_events.append(event),
                    agent_spec=agent_spec,
                    server_client=_SnapshotServerClient(),  # type: ignore[arg-type]
                )
            assert retained_client.closed is retain_subscription
            assert app_server.closed
            assert not forward_calls
            assert session_id not in runner_app_mod._AUTO_CODEX_APP_SERVERS
            return
        terminal_view = await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, event: published_events.append(event),
            agent_spec=agent_spec,
            server_client=_SnapshotServerClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    assert terminal_view.id == "terminal_codex_main"
    assert app_server.started is True
    expected_codex_home = codex_native_bridge.codex_home_for_bridge_dir(
        codex_native_bridge.bridge_dir_for_bridge_id(session_id)
    )
    assert app_server.codex_home == expected_codex_home
    assert build_calls[0]["model"] == "gpt-5.4-mini"
    assert build_calls[0]["cwd"] == tmp_path / "workspace"
    assert build_calls[0]["trust_project"] is True
    assert build_calls[0]["reconcile_process_registry"] is False
    assert build_calls[0]["developer_instructions"] == "Be a concise, careful coding assistant."
    assert len(launched_specs) == 1
    launched = launched_specs[0]
    assert launched.command == "codex-wrapper"
    # Older TUIs still need permission flags; Codex 0.154+ rejects them.
    assert launched.args == [
        "codex",
        "--",
        "-c",
        "check_for_update_on_startup=false",
        "--dangerously-bypass-hook-trust",
        *permission_args,
        "resume",
        "--remote",
        app_server.listen_url,
        thread_id,
    ]
    assert app_server.listen_url is not None
    assert app_server.listen_url.startswith("ws://127.0.0.1:")
    assert launched.env["OPENAI_API_KEY"] == "sk-test"
    assert "IGNORED" not in launched.env
    assert launched.env["CODEX_HOME"] == str(app_server.codex_home)
    assert launched.tmux_start_on_attach is False
    assert launched.tmux_allow_passthrough is True
    # A kept pane is what lets the exit event carry Codex's exit status and
    # final screen; without it an early exit is just "no server running".
    assert launched.keep_alive_after_exit is True
    launch_events = [
        r for r in caplog.records if getattr(r, "event_name", None) == "codex_terminal_launch"
    ]
    assert len(launch_events) == 1
    assert launch_events[0].session_id == session_id
    assert launch_events[0].attributes["command"] == "codex-wrapper"
    assert launch_events[0].attributes["resume"] is True
    from omnigent.harnesses.codex_native.launch_args import redact_codex_launch_args

    assert launch_events[0].attributes["args"] == shlex.join(
        redact_codex_launch_args(launched.args)
    )
    from omnigent.harnesses.codex_native.app_server import _format_codex_version

    assert launch_events[0].attributes["codex_cli_version"] == _format_codex_version(version)
    assert preload_calls == [
        (
            app_server.listen_url,
            thread_id,
            ["--config", "approval_policy=on-request"],
        )
    ]
    assert published_events[0]["type"] == "session.resource.created"
    assert len(forward_calls) == 1
    # The turn router handle is threaded through so the forwarder's ``finally``
    # tears down *its* endpoint, not a re-created session's live one.
    assert "turn_router" in forward_calls[0]
    del forward_calls[0]["turn_router"]
    assert forward_calls == [
        {
            "session_id": session_id,
            "bridge_dir": bridge_dir,
            "codex_ws_url": app_server.listen_url,
            "thread_id": thread_id,
            "client": retained_client if retain_subscription else None,
        }
    ]
    bridge_state = codex_native_bridge.read_bridge_state(bridge_dir)
    assert bridge_state is not None
    assert bridge_state.thread_id == thread_id
    assert bridge_state.socket_path == app_server.listen_url
    # The bridge state must carry the session workspace: without it the
    # Codex executor starts turns with the runner process's own cwd, so
    # web-driven shell tools run from the wrong directory.
    assert bridge_state.cwd == str(tmp_path / "workspace")
    # Resume state is published before the configured wrapper starts, so the
    # executor never needs a startup-timeout marker for this path.
    assert codex_native_bridge.read_bridge_startup_timeout(bridge_dir) is None
    assert "bridge state is preloaded" in caplog.text
    assert "no bridge-state wait extension is needed" in caplog.text


@pytest.mark.asyncio
async def test_auto_create_codex_terminal_fork_clones_rollout_and_resumes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A forked codex clone clones the source rollout and resumes its copy.

    When the clone has no ``external_session_id`` but carries the fork
    labels, the runner must clone the SOURCE's rollout into the clone's
    own ``CODEX_HOME`` under a freshly minted thread id, pre-set that id
    on the Omnigent session, and launch ``codex resume <minted_id>`` (not the
    source thread). A regression launches fresh (no ``resume`` subcommand)
    and the clone loses the source's Codex history.

    :param tmp_path: Temporary directory for isolated bridge state.
    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: None.
    """
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.harnesses.codex_native import main as codex_native
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_bridge_id,
        codex_home_for_bridge_dir,
    )
    from omnigent.runner import app as runner_app_mod
    from omnigent.stores.conversation_store import (
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
        FORK_SOURCE_LABEL_KEY,
    )

    session_id = "8aedf63f5e4046ae21b35fec5b35da50"
    source_id = "f143372bb481f9e85ffe3415f56f744f"
    source_thread = "019e96aa-0be2-7343-8d3b-6f914d60936b"
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(workspace))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    bridge_dir = bridge_dir_for_bridge_id(session_id)
    codex_native_bridge.write_bridge_state(
        bridge_dir,
        codex_native_bridge.CodexNativeBridgeState(
            session_id=session_id,
            socket_path="ws://127.0.0.1:1",
            thread_id="019e96aa-1111-7222-8333-444455556666",
            codex_home=str(tmp_path / "stale-codex-home"),
        ),
    )

    # Seed the SOURCE rollout in the source session's CODEX_HOME so the
    # fork branch finds something to clone.
    source_home = codex_home_for_bridge_dir(bridge_dir_for_bridge_id(source_id))
    source_rollout_dir = source_home / "sessions" / "2026" / "06" / "05"
    source_rollout_dir.mkdir(parents=True)
    (source_rollout_dir / f"rollout-2026-06-05T15-23-07-{source_thread}.jsonl").write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {"id": source_thread, "cwd": "/old/source/dir"},
            }
        )
        + "\n"
    )

    patched_external_ids: list[str] = []

    class _ForkSnapshotClient:
        """Server client returning a forked clone snapshot (no thread id)."""

        async def get(
            self,
            url: str,
            *,
            timeout: float,
            params: dict[str, str],
        ) -> httpx.Response:
            """
            Return the clone's snapshot carrying fork labels but no thread id.

            :param url: Request path, e.g. ``"/v1/sessions/8aedf63f5e4046ae21b35fec5b35da50"``.
            :param timeout: Request timeout in seconds.
            :param params: Snapshot metadata projection flags.
            :returns: HTTP 200 response with fork labels.
            """
            del timeout
            assert url == f"/v1/sessions/{session_id}"
            assert params == {
                "include_items": "false",
                "include_liveness": "false",
                "include_usage": "false",
            }
            return httpx.Response(
                200,
                json={
                    "external_session_id": None,
                    "labels": {
                        FORK_SOURCE_LABEL_KEY: source_id,
                        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY: source_thread,
                    },
                },
                request=httpx.Request("GET", url),
            )

        async def patch(
            self,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float,
            params: dict[str, str],
        ) -> httpx.Response:
            """
            Record the pre-set external_session_id PATCH.

            :param url: Request path.
            :param json: PATCH body, e.g. ``{"external_session_id": "..."}``.
            :param timeout: Request timeout in seconds.
            :param params: Snapshot response projection flags.
            :returns: HTTP 200 response.
            """
            del timeout
            assert url == f"/v1/sessions/{session_id}"
            assert params == {"include_usage": "false"}
            patched_external_ids.append(json["external_session_id"])
            return httpx.Response(200, json={}, request=httpx.Request("PATCH", url))

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = None

        def __init__(self) -> None:
            """:returns: None."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = codex_home_for_bridge_dir(bridge_dir_for_bridge_id(session_id))
            self.listen_url: str | None = None
            self.started = False
            # Provider/model -c overrides forwarded to the --remote TUI.
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """:returns: None."""
            self.started = True

        async def close(self) -> None:
            """:returns: None."""

    app_server = _FakeCodexAppServer()

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """
        Return the fake app-server.

        :param kwargs: Construction kwargs (ignored).
        :returns: Fake app-server.
        """
        del kwargs
        return app_server

    class _UnexpectedDiscoveryClient:
        """Discovery client that must not connect on the resume path."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """
            :param ws_url: App-server WebSocket URL.
            :param client_name: JSON-RPC client name.
            """
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """:raises AssertionError: Always — the fork resumes a known thread."""
            raise AssertionError("fork resume path must not connect discovery client")

        async def close(self) -> None:
            """:returns: None."""

    launched_specs: list[Any] = []

    class _FakeResourceRegistry:
        """Resource registry that records the launched terminal spec."""

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
            """
            Record the terminal launch request.

            :param session_id: Session id being launched.
            :param terminal_name: Terminal name, e.g. ``"codex"``.
            :param session_key: Terminal session key, e.g. ``"main"``.
            :param spec: Terminal launch spec.
            :param resource_role: Private runner resource marker.
            :returns: Terminal resource view.
            """
            del terminal_name, session_key, resource_role
            launched_specs.append(spec)
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    forward_calls: list[dict[str, Any]] = []
    preload_calls: list[tuple[str, str]] = []

    async def _fake_preload_thread(
        transport: str,
        loaded_thread_id: str,
        *,
        terminal_launch_args: list[str] | None = None,
        retain_client: bool = False,
        cwd: Path | None = None,
    ) -> None:
        """
        Record preloading of the cloned Codex thread.

        :param transport: App-server transport URL.
        :param loaded_thread_id: Thread id passed to ``thread/resume``.
        :returns: None.
        """
        assert codex_native_bridge.read_bridge_state(bridge_dir) is None, (
            "fork-resume must not expose stale bridge state before preload"
        )
        assert terminal_launch_args is None
        preload_calls.append((transport, loaded_thread_id))

    async def _fake_forward_known_thread(**kwargs: Any) -> None:
        """
        Record the known-thread forwarder invocation.

        :param kwargs: Forwarder keyword arguments.
        :returns: None.
        """
        forward_calls.append(kwargs)

    monkeypatch.setattr(
        codex_app_mod, "build_codex_native_server", _fake_build_codex_native_server
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _UnexpectedDiscoveryClient)
    monkeypatch.setattr(codex_app_mod, "preload_codex_thread_for_resume", _fake_preload_thread)
    monkeypatch.setattr(runner_app_mod, "_codex_forward_known_thread", _fake_forward_known_thread)

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        executor=ExecutorSpec(
            type="omnigent",
            config={"harness": "codex-native", "model": "gpt-5-default"},
        ),
    )

    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, event: None,
            agent_spec=agent_spec,
            server_client=_ForkSnapshotClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # A thread id was minted (uuidv7), pre-set on AP, and used for resume —
    # never the source thread id.
    assert len(patched_external_ids) == 1
    minted = patched_external_ids[0]
    assert minted != source_thread
    assert codex_native._CODEX_THREAD_ID_RE.fullmatch(minted)
    assert preload_calls == [(app_server.listen_url, minted)]
    assert forward_calls and forward_calls[0]["thread_id"] == minted

    launched = launched_specs[0]
    assert "resume" in launched.args
    assert launched.args[-1] == minted, (
        f"resume must target the minted thread id, got {launched.args}"
    )

    # The cloned rollout exists in the CLONE's CODEX_HOME under the minted
    # id, with session_meta.id and cwd rewritten.
    clone_home = codex_home_for_bridge_dir(bridge_dir_for_bridge_id(session_id))
    cloned = list(clone_home.glob(f"sessions/**/rollout-*-{minted}.jsonl"))
    assert len(cloned) == 1, f"expected one cloned rollout under {clone_home}, found {cloned}"
    meta = json.loads(cloned[0].read_text().splitlines()[0])["payload"]
    assert meta["id"] == minted
    assert meta["cwd"] == str(workspace.resolve())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "source_thread",
    [None, "019e96aa-0be2-7343-8d3b-6f914d60936b"],
    ids=["sdk-source", "missing-codex-rollout"],
)
async def test_auto_create_codex_terminal_fork_builds_rollout_from_items_and_resumes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    source_thread: str | None,
) -> None:
    """A forked codex clone builds from items when its source rollout is unavailable.

    This covers both a non-Codex source with no source thread id and an imported
    Codex source whose rollout lives outside Omnigent's private ``CODEX_HOME``.

    :param tmp_path: Temporary directory for isolated bridge state.
    :param monkeypatch: Pytest monkeypatch fixture.
    :param source_thread: Optional unavailable source Codex thread id.
    :returns: None.
    """
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.harnesses.codex_native import main as codex_native
    from omnigent.harnesses.codex_native.bridge import (
        bridge_dir_for_bridge_id,
        codex_home_for_bridge_dir,
    )
    from omnigent.runner import app as runner_app_mod
    from omnigent.stores.conversation_store import (
        FORK_CARRY_HISTORY_LABEL_KEY,
        FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY,
        FORK_SOURCE_LABEL_KEY,
    )

    session_id = "70a19efac3ec27549a70acbb4d0c635a"
    source_id = "4bd4c10aa9a3237eb5213cbeda70b70f"
    codeword = "swordfish-7281"
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(workspace))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)

    patched_external_ids: list[str] = []

    class _ItemsForkSnapshotClient:
        """Server client: clone snapshot (carry-history, no source thread)
        plus the copied Omnigent items the rollout is built from."""

        async def get(
            self,
            url: str,
            *,
            timeout: float | None = None,
            params: dict[str, Any] | None = None,
        ) -> httpx.Response:
            """
            Serve the clone snapshot and its copied items.

            :param url: Request path — the session snapshot or its items.
            :param timeout: Request timeout (snapshot fetch).
            :param params: Snapshot flags or items fetch pagination.
            :returns: HTTP 200 response.
            """
            del timeout
            if url == f"/v1/sessions/{session_id}":
                assert params == {
                    "include_items": "false",
                    "include_liveness": "false",
                    "include_usage": "false",
                }
                labels = {
                    FORK_SOURCE_LABEL_KEY: source_id,
                    FORK_CARRY_HISTORY_LABEL_KEY: "1",
                }
                if source_thread is not None:
                    labels[FORK_SOURCE_EXTERNAL_SESSION_LABEL_KEY] = source_thread
                return httpx.Response(
                    200,
                    json={
                        "external_session_id": None,
                        "labels": labels,
                    },
                    request=httpx.Request("GET", url),
                )
            assert url == f"/v1/sessions/{session_id}/items"
            assert params is not None and params.get("order") == "asc"
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": f"codeword {codeword}"}],
                        }
                    ],
                    "has_more": False,
                },
                request=httpx.Request("GET", url),
            )

        async def patch(
            self,
            url: str,
            *,
            json: dict[str, Any],
            timeout: float,
            params: dict[str, str],
        ) -> httpx.Response:
            """
            Record the pre-set external_session_id PATCH.

            :param url: Request path.
            :param json: PATCH body, e.g. ``{"external_session_id": "..."}``.
            :param timeout: Request timeout in seconds.
            :param params: Snapshot response projection flags.
            :returns: HTTP 200 response.
            """
            del timeout
            assert url == f"/v1/sessions/{session_id}"
            assert params == {"include_usage": "false"}
            patched_external_ids.append(json["external_session_id"])
            return httpx.Response(200, json={}, request=httpx.Request("PATCH", url))

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = None

        def __init__(self) -> None:
            """:returns: None."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = codex_home_for_bridge_dir(bridge_dir_for_bridge_id(session_id))
            self.listen_url: str | None = None
            self.started = False
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """:returns: None."""
            self.started = True

        async def close(self) -> None:
            """:returns: None."""

    app_server = _FakeCodexAppServer()

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """:param kwargs: Construction kwargs (ignored). :returns: Fake server."""
        del kwargs
        return app_server

    class _UnexpectedDiscoveryClient:
        """Discovery client that must not connect on the resume path."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """:param ws_url: App-server URL. :param client_name: RPC client name."""
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """:raises AssertionError: Always — the fork resumes a known thread."""
            raise AssertionError("fork resume path must not connect discovery client")

        async def close(self) -> None:
            """:returns: None."""

    launched_specs: list[Any] = []

    class _FakeResourceRegistry:
        """Resource registry that records the launched terminal spec."""

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
            """
            Record the terminal launch request.

            :param session_id: Session id being launched.
            :param terminal_name: Terminal name, e.g. ``"codex"``.
            :param session_key: Terminal session key.
            :param spec: Terminal launch spec.
            :param resource_role: Private runner resource marker.
            :returns: Terminal resource view.
            """
            del terminal_name, session_key, resource_role
            launched_specs.append(spec)
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    forward_calls: list[dict[str, Any]] = []
    preload_calls: list[tuple[str, str]] = []

    async def _fake_preload_thread(
        transport: str,
        loaded_thread_id: str,
        *,
        terminal_launch_args: list[str] | None = None,
        retain_client: bool = False,
        cwd: Path | None = None,
    ) -> None:
        """:param transport: App-server URL. :param loaded_thread_id: Resumed thread."""
        assert terminal_launch_args is None
        preload_calls.append((transport, loaded_thread_id))

    async def _fake_forward_known_thread(**kwargs: Any) -> None:
        """:param kwargs: Forwarder keyword arguments. :returns: None."""
        forward_calls.append(kwargs)

    monkeypatch.setattr(
        codex_app_mod, "build_codex_native_server", _fake_build_codex_native_server
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _UnexpectedDiscoveryClient)
    monkeypatch.setattr(codex_app_mod, "preload_codex_thread_for_resume", _fake_preload_thread)
    monkeypatch.setattr(runner_app_mod, "_codex_forward_known_thread", _fake_forward_known_thread)

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        executor=ExecutorSpec(
            type="omnigent",
            config={"harness": "codex-native", "model": "gpt-5-default"},
        ),
    )

    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, event: None,
            agent_spec=agent_spec,
            server_client=_ItemsForkSnapshotClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # A thread id was minted, pre-set on AP, and used for resume.
    assert len(patched_external_ids) == 1
    minted = patched_external_ids[0]
    assert codex_native._CODEX_THREAD_ID_RE.fullmatch(minted)
    assert preload_calls == [(app_server.listen_url, minted)]
    assert forward_calls and forward_calls[0]["thread_id"] == minted

    launched = launched_specs[0]
    assert "resume" in launched.args
    assert launched.args[-1] == minted, (
        f"resume must target the minted thread id, got {launched.args}"
    )

    # The rollout was BUILT (not cloned) in the clone's CODEX_HOME under the
    # minted id, carrying the source conversation's codeword — proving the
    # copied Omnigent items, not a source rollout, seeded the history.
    clone_home = codex_home_for_bridge_dir(bridge_dir_for_bridge_id(session_id))
    built = list(clone_home.glob(f"sessions/**/rollout-*-{minted}.jsonl"))
    assert len(built) == 1, f"expected one built rollout under {clone_home}, found {built}"
    body = built[0].read_text()
    meta = json.loads(body.splitlines()[0])["payload"]
    assert meta["id"] == minted
    assert meta["cwd"] == str(workspace.resolve())
    assert codeword in body, (
        "Built rollout must carry the source conversation's text from the "
        "copied Omnigent items; missing it means history was not seeded."
    )


@pytest.mark.asyncio
async def test_auto_create_codex_terminal_uses_worktree_workspace_not_bundle_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Codex-native launches in the session worktree, not the bundle dir.

    Regression for the worktree bug: ``_codex_workspace_from_spec_or_env``
    preferred ``ResolvedSpec.workdir`` (the runner's spec-bundle
    extraction dir) over the session workspace, stranding Codex in a temp
    dir with no ``.git`` and ignoring the worktree entirely. The fix reads
    the workspace from the session snapshot (the worktree path), matching
    claude-native and the per-session filesystem registry.

    This test sets up the adversarial case the bug got wrong: the snapshot
    reports a worktree workspace that differs from BOTH the runner env var
    and the ResolvedSpec bundle dir. The launched Codex app-server's
    ``cwd`` must be the worktree. If reverted, ``cwd`` would be the bundle
    dir and the ``cwd == worktree`` assertion fails.

    :param tmp_path: Temporary directory for isolated bridge/workspace state.
    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: None.
    """
    import omnigent.harness_startup_config as startup_config_mod
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.inner.datamodel import OSEnvSandboxSpec, OSEnvSpec
    from omnigent.runner import app as runner_app_mod

    session_id = "54e4d4410c43954c11e702f5a8646483"
    # Three distinct dirs so the assertion can only pass for the worktree:
    #   runner_env  — OMNIGENT_RUNNER_WORKSPACE (claude-native's source)
    #   bundle_dir  — ResolvedSpec.workdir (what the bug used)
    #   worktree    — the session's stored workspace (correct answer)
    runner_env = tmp_path / "runner_workspace"
    runner_env.mkdir()
    bundle_dir = tmp_path / "runner-specs" / f"{session_id}-v1"
    bundle_dir.mkdir(parents=True)
    worktree = tmp_path / "repo-worktrees" / "feature-x"
    worktree.mkdir(parents=True)

    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(runner_env))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    bridge_dir = codex_native_bridge.bridge_dir_for_bridge_id(session_id)
    codex_native_bridge.write_bridge_state(
        bridge_dir,
        codex_native_bridge.CodexNativeBridgeState(
            session_id=session_id,
            socket_path="ws://127.0.0.1:1",
            thread_id="019e96aa-1111-7222-8333-444455556666",
            codex_home=str(tmp_path / "stale-codex-home"),
        ),
    )
    codex_native_bridge.write_bridge_startup_timeout(bridge_dir, 120.0)

    class _WorktreeSnapshotClient:
        """Server client whose session snapshot carries a worktree workspace."""

        async def get(
            self,
            url: str,
            *,
            timeout: float,
            params: dict[str, str] | None = None,
        ) -> httpx.Response:
            """
            Return the session snapshot with a worktree ``workspace``.

            :param url: Request path, e.g.
                ``"/v1/sessions/54e4d4410c43954c11e702f5a8646483"``.
            :param timeout: Request timeout in seconds.
            :param params: Snapshot metadata projection flags.
            :returns: HTTP 200 response carrying the worktree workspace.
            """
            del timeout, params
            assert url == f"/v1/sessions/{session_id}"
            return httpx.Response(
                200,
                json={
                    "workspace": str(worktree),
                    "terminal_launch_args": None,
                    "model_override": None,
                    "external_session_id": None,
                },
                request=httpx.Request("GET", url),
            )

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = None

        def __init__(self) -> None:
            """:returns: None."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = tmp_path / "codex-home"
            self.listen_url: str | None = None
            self.started = False
            # Provider/model -c overrides forwarded to the --remote TUI.
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """:returns: None."""
            self.started = True

        async def close(self) -> None:
            """:returns: None."""

    app_server = _FakeCodexAppServer()
    build_calls: list[dict[str, Any]] = []

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """
        Capture app-server construction.

        :param kwargs: Keyword arguments passed by the runner helper.
        :returns: Fake app-server.
        """
        build_calls.append(kwargs)
        return app_server

    class _FakeDiscoveryClient:
        """App-server client for the fresh-thread discovery path."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """
            :param ws_url: App-server WebSocket URL.
            :param client_name: JSON-RPC client name.
            """
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """:returns: None."""

        async def close(self) -> None:
            """:returns: None."""

    discovery_observations: list[tuple[dict[str, Any], Any, float | None]] = []

    async def _fake_discover_thread_and_forward(**kwargs: Any) -> None:
        """
        Stand in for the fresh-session discovery forwarder.

        :param kwargs: Forwarder keyword arguments.
        :returns: None.
        """
        discovery_observations.append(
            (
                kwargs,
                codex_native_bridge.read_bridge_state(bridge_dir),
                codex_native_bridge.read_bridge_startup_timeout(bridge_dir),
            )
        )

    launch_captured: dict[str, Any] = {}

    class _FakeResourceRegistry:
        """Resource registry that records the launched terminal spec."""

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
            """
            Record the terminal launch request.

            :param session_id: Session id being launched.
            :param terminal_name: Terminal name, e.g. ``"codex"``.
            :param session_key: Terminal session key, e.g. ``"main"``.
            :param spec: Terminal launch spec.
            :param resource_role: Private runner resource marker.
            :param parent_os_env: Agent os_env threaded as the inheritance
                parent so the agent's sandbox / egress / passthrough apply.
            :returns: Terminal resource view.
            """
            del session_key, resource_role
            launch_captured["spec"] = spec
            launch_captured["parent_os_env"] = parent_os_env
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    monkeypatch.setattr(
        codex_app_mod,
        "build_codex_native_server",
        _fake_build_codex_native_server,
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _FakeDiscoveryClient)
    monkeypatch.setattr(
        runner_app_mod,
        "_codex_discover_thread_and_forward",
        _fake_discover_thread_and_forward,
    )
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_config",
        lambda _cfg: (None, {}),
    )
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_args",
        lambda _harness, args, *, cfg: list(args),
    )

    # agent_spec is a ResolvedSpec whose workdir is the bundle dir — the
    # exact value the old code wrongly used as the cwd. Its os_env declares
    # sandbox: none, so the launched terminal must inherit that (not the
    # platform default) — see the sandbox-override regression note below.
    codex_os_env = OSEnvSpec(
        type="caller_process",
        cwd=".",
        sandbox=OSEnvSandboxSpec(type="none"),
    )
    agent_spec = ResolvedSpec(
        spec=AgentSpec(
            spec_version=1,
            name="codex",
            instructions="Be a concise, careful coding assistant.",
            executor=ExecutorSpec(
                type="omnigent",
                config={"harness": "codex-native", "model": "gpt-5-default"},
            ),
            os_env=codex_os_env,
        ),
        workdir=bundle_dir,
    )

    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, event: None,
            agent_spec=agent_spec,
            server_client=_WorktreeSnapshotClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    assert len(discovery_observations) == 1
    discover_kwargs, observed_state, observed_timeout = discovery_observations[0]
    assert discover_kwargs["bridge_dir"] == bridge_dir
    assert observed_state is None, (
        "fresh Codex launch must clear stale bridge state before the "
        "discovery forwarder publishes the new thread"
    )
    assert observed_timeout is None
    assert discover_kwargs["thread_start_timeout_seconds"] is None

    # The Codex app-server cwd must be the worktree (resolved — the launch
    # config normalizes with expanduser().resolve()). A failure here means
    # the workspace resolution regressed: the bundle dir means the old
    # ResolvedSpec.workdir bug is back; the runner env dir means the
    # snapshot workspace was ignored.
    assert build_calls[0]["cwd"] == worktree.resolve(), (
        f"Codex launched in {build_calls[0]['cwd']!r}; expected the worktree "
        f"{worktree.resolve()!r}. bundle_dir={bundle_dir!r} would mean the "
        f"ResolvedSpec.workdir bug regressed; runner_env={runner_env!r} would "
        "mean the session snapshot workspace was ignored."
    )
    assert build_calls[0]["cwd"] != bundle_dir.resolve()  # never the spec-bundle dir
    assert build_calls[0]["developer_instructions"] == "Be a concise, careful coding assistant."

    # Sandbox-override regression: the launched Codex terminal must inherit
    # the agent's sandbox: none rather than falling back to the platform
    # default (bwrap). Without it, a codex-native agent declaring
    # ``os_env.sandbox.type: none`` is wrongly forced into bwrap.
    launched_sandbox = launch_captured["spec"].os_env.sandbox
    assert launched_sandbox is not None and launched_sandbox.type == "none"
    assert launch_captured["parent_os_env"] is codex_os_env

    # A transient / unparseable version probe must not strand a runner-owned
    # session behind Codex's terminal-only hook review screen. Omnigent's
    # supported Codex floor is newer than the release that added this flag.
    assert app_server.codex_cli_version is None
    assert launch_captured["spec"].args[:3] == [
        "-c",
        "check_for_update_on_startup=false",
        "--dangerously-bypass-hook-trust",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("marker_write_fails", "login_required"),
    [
        pytest.param(False, False, id="marker-published"),
        pytest.param(True, False, id="marker-write-fails"),
        pytest.param(False, True, id="login-required"),
    ],
)
async def test_auto_create_codex_terminal_starts_relay_at_session_creation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    marker_write_fails: bool,
    login_required: bool,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The tool relay is started at session creation, non-blocking.

    Root-cause fix for the ~30s first-turn stall: the relay (which writes
    ``tool_relay.json`` codex reads via serve-mcp) must be started when the
    session is created, into the same bridge dir codex uses, and WITHOUT
    awaiting the tools/list_changed notification. Previously the relay was
    only started on the first turn with ``await_notify=True``, which blocked
    on codex's MCP bridge ``server.json`` — a file that only appears once
    codex runs the turn — until ``post_tools_changed``'s 30s timeout.

    Asserts ``_auto_create_codex_terminal`` invokes the injected
    ``ensure_comment_relay`` exactly once, for this session's bridge dir,
    with ``await_notify=False``. If the call regressed to the first-turn
    path the spy would never fire here; if it regressed to
    ``await_notify=True`` the assertion on that kwarg would fail.

    :param tmp_path: Temporary directory for isolated bridge state.
    :param monkeypatch: Pytest monkeypatch fixture.
    :returns: None.
    """
    import omnigent.harness_startup_config as startup_config_mod
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.runner import app as runner_app_mod

    session_id = "de154ca6405fb8912623984a14a2b044"
    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    monkeypatch.setattr(
        "omnigent.harnesses.codex_native.process_registry.reap_codex_native_processes_for_state_dir",
        lambda _bridge_dir: pytest.fail("fresh Codex launch ran stale-writer recovery"),
    )
    caplog.set_level(logging.INFO, logger="omnigent.runner.app")

    class _SnapshotClient:
        """Fresh-session snapshot (no external thread → discovery path)."""

        async def get(
            self,
            url: str,
            *,
            timeout: float,
            params: dict[str, str] | None = None,
        ) -> httpx.Response:
            """:returns: HTTP 200 fresh-session snapshot."""
            del timeout, url, params
            return httpx.Response(
                200,
                json={
                    "workspace": str(tmp_path / "workspace"),
                    "terminal_launch_args": None,
                    "model_override": None,
                    "external_session_id": None,
                },
                request=httpx.Request("GET", f"/v1/sessions/{session_id}"),
            )

    class _FakeCodexAppServer:
        """Minimal app-server object."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = None

        def __init__(self) -> None:
            """:returns: None."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = tmp_path / "codex-home"
            self.listen_url: str | None = None
            # Provider/model -c overrides forwarded to the --remote TUI.
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """:returns: None."""

        async def close(self) -> None:
            """:returns: None."""

    class _FakeDiscoveryClient:
        """No-op app-server client for the discovery path."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """:param ws_url: ws url. :param client_name: client name."""
            del ws_url, client_name

        async def connect(self) -> None:
            """:returns: None."""

        async def close(self) -> None:
            """:returns: None."""

    class _FakeResourceRegistry:
        """Resource registry returning a fixed terminal view."""

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
            """:returns: A fixed terminal resource view."""
            del terminal_name, session_key, spec, resource_role
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    discover_calls: list[dict[str, Any]] = []

    async def _fake_discover(**kwargs: Any) -> None:
        """:returns: None — stands in for the discovery forwarder."""
        discover_calls.append(kwargs)

    monkeypatch.setattr(
        codex_app_mod, "build_codex_native_server", lambda **k: _FakeCodexAppServer()
    )
    monkeypatch.setattr(
        codex_app_mod,
        "resolve_native_codex_launch",
        lambda **_kwargs: codex_app_mod.NativeCodexLaunch(
            config_overrides=[],
            model="gpt-5-default",
            profile=None,
            summary="test route",
            login_required=login_required,
        ),
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _FakeDiscoveryClient)
    monkeypatch.setattr(runner_app_mod, "_codex_discover_thread_and_forward", _fake_discover)
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_config",
        lambda _cfg: (None, {"codex-native": {"command": "codex-wrapper"}}),
    )
    monkeypatch.setattr(
        startup_config_mod,
        "resolve_harness_args",
        lambda _harness, args, *, cfg: list(args),
    )
    if marker_write_fails:

        def _raise_marker_write_error(_bridge_dir: Path, _timeout: float) -> None:
            raise OSError("read-only bridge directory")

        monkeypatch.setattr(
            codex_native_bridge,
            "write_bridge_startup_timeout",
            _raise_marker_write_error,
        )

    relay_calls: list[dict[str, Any]] = []

    async def _spy_ensure_relay(sid: str, **kwargs: Any) -> None:
        """Record the relay-start invocation."""
        relay_calls.append({"session_id": sid, **kwargs})

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        executor=ExecutorSpec(
            type="omnigent",
            config={"harness": "codex-native", "model": "gpt-5-default"},
        ),
    )

    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, event: None,
            agent_spec=agent_spec,
            server_client=_SnapshotClient(),  # type: ignore[arg-type]
            ensure_comment_relay=_spy_ensure_relay,
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # Exactly one relay start, at session creation, for this session's bridge
    # dir, and non-blocking (await_notify=False) — the crux of the fix.
    assert len(relay_calls) == 1, relay_calls
    assert relay_calls[0]["session_id"] == session_id
    assert relay_calls[0]["explicit_bridge_dir"] == codex_native_bridge.bridge_dir_for_bridge_id(
        session_id
    )
    assert relay_calls[0]["await_notify"] is False
    assert len(discover_calls) == 1
    # A failed marker write falls the forwarder back to the legacy timeout
    # too, keeping it aligned with the executor's unextended legacy wait.
    expected_timeout = None if marker_write_fails or login_required else 120.0
    assert discover_calls[0]["thread_start_timeout_seconds"] == expected_timeout
    assert codex_native_bridge.read_bridge_startup_timeout(
        codex_native_bridge.bridge_dir_for_bridge_id(session_id)
    ) == (None if marker_write_fails or login_required else 120.0)
    if login_required:
        assert "requires interactive login" in caplog.text
        assert "preserving the unbounded sign-in wait" in caplog.text
    else:
        assert "configured command 'codex-wrapper' gets a 120s thread-start budget" in caplog.text


@pytest.mark.asyncio
async def test_claude_native_first_turn_not_blocked_by_cold_bridge_notify(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cold bridge does not block dispatch or strand a cancelled worker."""
    session_id = uuid.uuid4().hex
    # claude-native pins the bridge tree under /tmp (see _ensure_secure_dir);
    # use the real per-user bridge dir like tests/runner/test_comment_relay.py
    # and rmtree it on teardown rather than redirecting _BRIDGE_ROOT.
    bridge_dir = bridge_dir_for_bridge_id(session_id)
    # start_tool_relay writes tool_relay.json INTO the bridge dir but does not
    # create it — mirror the client's prepare_bridge_dir before launch.
    prepare_bridge_dir(session_id, workspace=tmp_path)

    polling_started = threading.Event()
    worker_finished = threading.Event()
    cancellation_event: threading.Event | None = None
    notification_task: asyncio.Task[Any] | None = None
    read_json = claude_native_bridge._read_json_file
    post_tools_changed = claude_native_bridge.post_tools_changed

    def _observe_read(path: Path) -> dict[str, Any]:
        result = read_json(path)
        if path == bridge_dir / "server.json":
            polling_started.set()
        return result

    def _observe_notification(target: Path, *, cancelled: threading.Event) -> None:
        nonlocal cancellation_event
        cancellation_event = cancelled
        try:
            post_tools_changed(target, cancelled=cancelled)
        finally:
            worker_finished.set()

    monkeypatch.setattr(claude_native_bridge, "_read_json_file", _observe_read)
    monkeypatch.setattr(claude_native_bridge, "post_tools_changed", _observe_notification)

    spec = AgentSpec(
        spec_version=1,
        name="claude",
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-native"}),
    )

    async def _resolver(agent_id: str, session_id: str | None = None) -> AgentSpec:
        """Resolve every request to the claude-native spec under test."""
        del agent_id, session_id
        return spec

    hc = _ScriptedHarnessClient(
        [
            _sse({"type": "response.created", "response": {"id": "resp_1"}}),
            _sse({"type": "response.completed", "response": {"id": "resp_1"}}),
        ]
    )
    pm = _FakeProcessManager(hc)
    app = create_runner_app(
        process_manager=pm,  # type: ignore[arg-type]
        spec_resolver=_resolver,
        server_client=NullServerClient(),  # type: ignore[arg-type]
    )

    try:
        async with _runner_client(app) as client:
            resp = await client.post(
                f"/v1/sessions/{session_id}/events",
                json={
                    "type": "message",
                    "role": "user",
                    "model": "claude-agent",
                    "agent_id": "3a9725fd4de1720e83e53a632da41da8",
                    "content": [{"type": "input_text", "text": "hi"}],
                },
            )
            assert resp.status_code == 202, f"{resp.status_code} {resp.text}"

            # Observe the real readiness poll, not merely submission to the executor.
            for _ in range(300):
                if polling_started.is_set():
                    break
                await asyncio.sleep(0.01)
            assert polling_started.is_set(), "notification never reached bridge readiness polling"
            assert not worker_finished.is_set()

            # The absent bridge must not prevent the first turn reaching the harness.
            for _ in range(300):
                if hc.posted_bodies:
                    break
                await asyncio.sleep(0.01)
            assert hc.posted_bodies, (
                "claude-native first turn never reached the harness while the "
                "tools/list_changed delivery was blocked — the turn is gated on a "
                "cold-bridge notification."
            )
            assert not (bridge_dir / "server.json").exists()
            assert not worker_finished.is_set()

            tasks = [
                task
                for task in asyncio.all_tasks()
                if task.get_name() == f"tools-changed:{session_id}"
            ]
            assert len(tasks) == 1
            notification_task = tasks[0]
            notification_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await notification_task
            assert await asyncio.to_thread(worker_finished.wait, 1.0), (
                "cancelling the notification task left its readiness worker running"
            )
    finally:
        # Release a worker after a failed assertion, without masking a broken cancel path.
        if cancellation_event is not None:
            cancellation_event.set()
        if notification_task is not None:
            notification_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await notification_task
        with contextlib.suppress(httpx.HTTPError):
            async with _runner_client(app) as cleanup_client:
                await cleanup_client.delete(f"/v1/sessions/{session_id}")
        shutil.rmtree(bridge_dir, ignore_errors=True)


@pytest.mark.parametrize("parent_host_id", ["21506f91db53823dba9a99e9b0db742d", None])
@pytest.mark.asyncio
async def test_codex_subagent_always_needs_runner_terminal(
    parent_host_id: str | None,
) -> None:
    """
    Codex-native sub-agent children always need a runner-created terminal.

    A sub-agent child (created via ``sys_session_send``) carries a
    ``parent_session_id`` but no ``host_id`` of its own, and no CLI ever
    manages its terminal. The gate must therefore return ``True`` regardless
    of whether the PARENT was host-spawned (``host_id`` present) or CLI-driven
    (``host_id`` None).

    The ``parent_host_id=None`` case is the regression: gating the child
    on the parent's ``host_id`` made codex-native sub-agents under a CLI-driven
    parent (e.g. nessie run via ``omnigent run --server``) silently never get
    a terminal, so ``sys_session_send`` dispatch no-op'd. If that case returns
    ``False``, the regression has reappeared.

    :param parent_host_id: The parent session's ``host_id`` value to simulate;
        ``"21506f91db53823dba9a99e9b0db742d"`` (web-UI parent) or ``None`` (CLI-driven parent).
    """
    from omnigent.runner.app import _codex_session_needs_runner_terminal

    class _Client:
        async def get(
            self,
            url: str,
            *,
            timeout: float,
            params: dict[str, str] | None = None,
        ) -> httpx.Response:
            """
            Return child then parent session snapshots.

            :param url: Omnigent session snapshot URL.
            :param timeout: HTTP timeout in seconds.
            :param params: Snapshot metadata projection flags.
            :returns: Fake Omnigent session response.
            """
            del timeout, params
            if url.endswith("/ff5cac23d0beb79fad914046049f32ff"):
                return httpx.Response(
                    200,
                    json={
                        "id": "ff5cac23d0beb79fad914046049f32ff",
                        "parent_session_id": "ead6d59a6b650d19dbdf61ec32426f4e",
                        "host_id": None,
                    },
                    request=httpx.Request("GET", url),
                )
            if url.endswith("/ead6d59a6b650d19dbdf61ec32426f4e"):
                return httpx.Response(
                    200,
                    json={"id": "ead6d59a6b650d19dbdf61ec32426f4e", "host_id": parent_host_id},
                    request=httpx.Request("GET", url),
                )
            return httpx.Response(404, request=httpx.Request("GET", url))

    # True for both parent host_ids; a False for the None parent = regressed.
    assert (
        await _codex_session_needs_runner_terminal(_Client(), "ff5cac23d0beb79fad914046049f32ff")
        is True
    )


@pytest.mark.asyncio
async def test_codex_session_needs_runner_terminal_false_without_client() -> None:
    """
    With no server client (embedded/test runner) the gate cannot confirm a
    host-spawned or sub-agent session, so it returns ``False`` — skipping
    auto-create rather than risking a competing setup.
    """
    from omnigent.runner.app import _codex_session_needs_runner_terminal

    assert (
        await _codex_session_needs_runner_terminal(None, "8af356d908005a65f872c246158c6293")
        is False
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "setup_error", "forward_error", "cancelled"])
async def test_codex_known_thread_forwarder_closes_retained_subscription(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, outcome: str
) -> None:
    """Ownership transfer must close the preload client on every forwarder exit."""
    from omnigent.harnesses.codex_native import forwarder as codex_forwarder
    from omnigent.runner import _entry
    from omnigent.runner.native import orchestration

    closed: list[str] = []

    class _Client:
        async def close(self) -> None:
            closed.append("client")

    class _AppServer:
        async def close(self) -> None:
            closed.append("server")

    client = _Client()

    def server_url(_name: str) -> str:
        if outcome == "setup_error":
            raise RuntimeError("setup failed")
        return "http://127.0.0.1:8000"

    async def forward(**kwargs: Any) -> None:
        assert kwargs["client"] is client
        assert not closed
        if outcome == "forward_error":
            raise RuntimeError("forward failed")
        if outcome == "cancelled":
            raise asyncio.CancelledError

    monkeypatch.setattr(orchestration, "_required_runner_env", server_url)
    monkeypatch.setattr(_entry, "_make_auth_token_factory", lambda: None)
    monkeypatch.setattr(codex_forwarder, "supervise_forwarder", forward)
    session_id = "conv_test_retained_preload"
    orchestration._AUTO_CODEX_APP_SERVERS[session_id] = _AppServer()  # type: ignore[assignment]
    operation = orchestration._codex_forward_known_thread(
        session_id=session_id,
        bridge_dir=tmp_path,
        codex_ws_url="ws://127.0.0.1:9876",
        thread_id="thread_test",
        client=client,  # type: ignore[arg-type]
    )
    if outcome == "success":
        await operation
    else:
        error = asyncio.CancelledError if outcome == "cancelled" else RuntimeError
        with pytest.raises(error):
            await operation
    assert closed == ["client", "server"]
    assert session_id not in orchestration._AUTO_CODEX_APP_SERVERS


@pytest.mark.asyncio
async def test_codex_discover_thread_and_forward_cleans_up_on_discovery_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """
    When the fresh TUI never starts a thread, the background task must close
    the listener AND the per-session app-server and drop it from the registry.
    Otherwise each failed host-spawned codex session orphans an app-server
    subprocess (and a dangling listener) for the runner's lifetime.
    """
    from omnigent.harnesses.codex_native import forwarder as codex_native_forwarder
    from omnigent.runner.app import (
        _AUTO_CODEX_APP_SERVERS,
        _codex_discover_thread_and_forward,
    )

    closed = {"client": False, "app_server": False}

    class _Client:
        async def close(self) -> None:
            closed["client"] = True

    class _AppServer:
        async def close(self) -> None:
            closed["app_server"] = True

    async def _raise_no_thread(_client: object) -> str:
        raise TimeoutError("no thread/started observed")

    # The helper lazily imports wait_for_thread_started from the forwarder
    # module on each call, so patching the module attribute takes effect.
    monkeypatch.setattr(codex_native_forwarder, "wait_for_thread_started", _raise_no_thread)

    session_id = "2053b47e49239a8c24e3cd30cdb21c8e"
    _AUTO_CODEX_APP_SERVERS[session_id] = _AppServer()
    try:
        await _codex_discover_thread_and_forward(
            session_id=session_id,
            bridge_dir=tmp_path,
            codex_ws_url="ws://127.0.0.1:1",
            codex_home=tmp_path / "codex-home",
            workspace=str(tmp_path / "workspace"),
            event_client=_Client(),  # type: ignore[arg-type]
            routing_summary="provider 'test' (model=gpt-test)",
        )
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # client closed = no dangling reader task/socket; app_server closed = no
    # orphaned subprocess; dropped from registry = no leaked dict reference.
    assert closed["client"] is True
    assert closed["app_server"] is True
    assert session_id not in _AUTO_CODEX_APP_SERVERS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("exc", "thread_start_timeout_seconds", "expected_cause"),
    [
        (TimeoutError("no thread/started observed"), None, "startup timed out after 30s"),
        (TimeoutError("no thread/started observed"), 120.0, "startup timed out after 120s"),
        (
            RuntimeError("event stream ended"),
            None,
            "event stream ended before a thread was created",
        ),
    ],
)
async def test_codex_discover_thread_and_forward_records_accurate_startup_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    exc: Exception,
    thread_start_timeout_seconds: float | None,
    expected_cause: str,
) -> None:
    """
    The startup breadcrumb must describe the actual failure mode: a timeout
    reads as "startup timed out", while a RuntimeError (TUI exited / event
    stream ended) must NOT be mislabeled as a timeout.
    """
    from omnigent.harnesses.codex_native import forwarder as codex_native_forwarder
    from omnigent.harnesses.codex_native.bridge import (
        read_bridge_startup_error,
        read_bridge_startup_failure,
    )
    from omnigent.runner.app import (
        _AUTO_CODEX_APP_SERVERS,
        _codex_discover_thread_and_forward,
    )

    class _Client:
        async def close(self) -> None:
            return None

    class _AppServer:
        async def close(self) -> None:
            return None

    async def _raise(*_args: object, **_kwargs: object) -> str:
        raise exc

    monkeypatch.setattr(codex_native_forwarder, "wait_for_thread_started", _raise)

    session_id = "5cb1fea582a3bd8aad3619ca820af75b"
    _AUTO_CODEX_APP_SERVERS[session_id] = _AppServer()
    try:
        await _codex_discover_thread_and_forward(
            session_id=session_id,
            bridge_dir=tmp_path,
            codex_ws_url="ws://127.0.0.1:1",
            codex_home=tmp_path / "codex-home",
            workspace=str(tmp_path / "workspace"),
            event_client=_Client(),  # type: ignore[arg-type]
            routing_summary="provider 'test' (model=gpt-test)",
            thread_start_timeout_seconds=thread_start_timeout_seconds,
        )
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    recorded = read_bridge_startup_error(tmp_path)
    assert recorded is not None
    assert expected_cause in recorded
    assert type(exc).__name__ in recorded
    # A RuntimeError must never be described as a timeout.
    if not isinstance(exc, TimeoutError):
        assert "timed out" not in recorded
    # A hard startup failure carries its own code so the turn error is not a
    # bare exception class name.
    failure = read_bridge_startup_failure(tmp_path)
    assert failure is not None
    assert failure.code == "codex_thread_not_started"


@pytest.mark.parametrize(
    ("screen", "expected_code", "expected_title"),
    [
        (
            "dbexec: launcher 1.2.3\nSign in to continue:\n"
            "  https://signin.example.com/device\n  code: HQ7M-2KPD\nwaiting for sign-in...\n",
            "databricks_sign_in_pending",
            "Codex can't start until you sign in to Databricks",
        ),
        ("Loading configuration...\n", "agent_startup_pending", "Codex is still starting"),
    ],
)
@pytest.mark.asyncio
async def test_codex_discover_thread_and_forward_waits_while_terminal_alive(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    screen: str,
    expected_code: str,
    expected_title: str,
) -> None:
    """
    A thread-start deadline with a live pane records a pending cause and keeps waiting.

    A launcher wrapper can park the pane on a sign-in prompt for longer than
    the thread-start budget. Tearing the backend down there strands the user:
    the pane cannot connect once the sign-in completes, and every send fails
    fast on the saved error until the terminal is recreated. Instead the
    runner records why chat turns cannot run yet (lifting the sign-in link
    from the pane when it shows one), waits without a deadline, and clears the
    record once the thread starts.
    """
    from omnigent.harnesses.codex_native import forwarder as codex_native_forwarder
    from omnigent.runner.app import (
        _AUTO_CODEX_APP_SERVERS,
        _codex_discover_thread_and_forward,
    )

    thread_id = "019e96aa-abcd-7343-8d3b-6f914d60936b"
    timeline: list[str] = []
    wait_calls: list[dict[str, object]] = []
    pending_seen: list[codex_native_bridge.CodexStartupFailure | None] = []
    real_async_client = httpx.AsyncClient

    def _mock_client(**kwargs: Any) -> httpx.AsyncClient:
        return real_async_client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
            **kwargs,
        )

    async def _fake_wait(*_args: object, **kwargs: object) -> str:
        wait_calls.append(kwargs)
        if len(wait_calls) == 1:
            raise TimeoutError
        pending_seen.append(codex_native_bridge.read_bridge_startup_failure(tmp_path))
        timeline.append("thread_started")
        return thread_id

    async def _fake_supervise(**_kwargs: object) -> None:
        return None

    class _Client:
        async def close(self) -> None:
            return None

    class _AppServer:
        async def close(self) -> None:
            timeline.append("app_server_closed")

    class _Terminal:
        diagnostic_id = "terminal-1"
        reads = 0
        joined_reads = 0

        async def is_alive(self) -> bool:
            return True

        async def read(
            self, scrollback: int = 0, *, join_wrapped: bool = False
        ) -> dict[str, object]:
            del scrollback
            self.reads += 1
            self.joined_reads += int(join_wrapped)
            return {"screen": screen}

    monkeypatch.setattr(codex_native_forwarder, "wait_for_thread_started", _fake_wait)
    monkeypatch.setattr(codex_native_forwarder, "supervise_forwarder", _fake_supervise)
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    monkeypatch.setattr(httpx, "AsyncClient", _mock_client)

    session_id = "3c0a9d4e6b8f4a2c9e1d7b5a3f6c8e0d"
    app_server = _AppServer()
    terminal = _Terminal()
    _AUTO_CODEX_APP_SERVERS[session_id] = app_server  # type: ignore[assignment]
    try:
        await _codex_discover_thread_and_forward(
            session_id=session_id,
            bridge_dir=tmp_path,
            codex_ws_url="ws://127.0.0.1:1",
            codex_home=tmp_path / "codex-home",
            workspace=str(tmp_path / "workspace"),
            event_client=_Client(),  # type: ignore[arg-type]
            routing_summary="Databricks ucode profile 'oss'",
            app_server=app_server,  # type: ignore[arg-type]
            terminal_instance=terminal,  # type: ignore[arg-type]
            thread_start_timeout_seconds=120.0,
        )
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # One bounded wait, then an open-ended one once the pending cause is recorded.
    assert wait_calls == [{"timeout": 120.0}, {"timeout": None}]
    # Read once, with wrapped rows joined so a wide address comes back whole.
    assert (terminal.reads, terminal.joined_reads) == (1, 1)
    (pending,) = pending_seen
    assert pending is not None
    assert pending.code == expected_code
    assert pending.title == expected_title
    assert pending.remediation is not None
    # The transcript never carries the one-time address or code; the card
    # fetches the live link from the host when clicked.
    assert "http" not in pending.remediation
    if expected_code == "databricks_sign_in_pending":
        assert pending.remediation.startswith("Open the sign-in link and sign in. Codex continues")
    # The backend outlived the deadline and closed only after forwarding ended.
    assert timeline == ["thread_started", "app_server_closed"]
    # The thread start cleared the pending record and published bridge state.
    assert codex_native_bridge.read_bridge_startup_error(tmp_path) is None
    state = codex_native_bridge.read_bridge_state(tmp_path)
    assert state is not None
    assert state.thread_id == thread_id


@pytest.mark.parametrize(
    ("screen", "expect_early"),
    [
        (
            "dbcert: Logging in via SSO...\n"
            "dbcert: If the browser does not open automatically, please open the following URL:\n"
            "https://databricks.okta.com/oauth2/v1/authorize?client_id=abc&state=xyz\n",
            True,
        ),
        ("Codex requirements updated at /etc/codex/requirements.toml\n", False),
    ],
)
@pytest.mark.asyncio
async def test_codex_discover_thread_and_forward_records_a_sign_in_prompt_before_the_budget(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    screen: str,
    expect_early: bool,
) -> None:
    """
    A stable sign-in prompt on the pane is recorded as soon as it is seen, not at the budget.

    The chat turn fails fast on the record, so the card with the sign-in step
    appears seconds after the send instead of two minutes later. Ordinary
    startup output is never mistaken for a prompt: that pane still waits for
    the full budget before the generic pending cause is recorded.
    """
    from omnigent.harnesses.codex_native import forwarder as codex_native_forwarder
    from omnigent.runner.app import (
        _AUTO_CODEX_APP_SERVERS,
        _codex_discover_thread_and_forward,
    )
    from omnigent.runner.native import orchestration

    thread_id = "019e96aa-abcd-7343-8d3b-6f914d60936b"
    wait_calls: list[dict[str, object]] = []
    at_deadline: list[codex_native_bridge.CodexStartupFailure | None] = []
    pending_seen: list[codex_native_bridge.CodexStartupFailure | None] = []
    real_async_client = httpx.AsyncClient

    def _mock_client(**kwargs: Any) -> httpx.AsyncClient:
        return real_async_client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={})),
            **kwargs,
        )

    async def _fake_wait(*_args: object, **kwargs: object) -> str:
        wait_calls.append(kwargs)
        if len(wait_calls) == 1:
            # The budgeted wait: a prompt must interrupt it, anything else runs
            # it out (shortened here) with no record made in the meantime.
            await asyncio.sleep(3600.0 if expect_early else 0.2)
            at_deadline.append(codex_native_bridge.read_bridge_startup_failure(tmp_path))
            raise TimeoutError
        pending_seen.append(codex_native_bridge.read_bridge_startup_failure(tmp_path))
        return thread_id

    async def _fake_supervise(**_kwargs: object) -> None:
        return None

    class _Client:
        async def close(self) -> None:
            return None

    class _AppServer:
        async def close(self) -> None:
            return None

    class _Terminal:
        diagnostic_id = "terminal-1"
        reads = 0

        async def is_alive(self) -> bool:
            return True

        async def read(
            self, scrollback: int = 0, *, join_wrapped: bool = False
        ) -> dict[str, object]:
            del scrollback, join_wrapped
            self.reads += 1
            return {"screen": screen}

    monkeypatch.setattr(orchestration, "_CODEX_SIGN_IN_POLL_INTERVAL_S", 0.01)
    monkeypatch.setattr(codex_native_forwarder, "wait_for_thread_started", _fake_wait)
    monkeypatch.setattr(codex_native_forwarder, "supervise_forwarder", _fake_supervise)
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    monkeypatch.setattr(httpx, "AsyncClient", _mock_client)

    session_id = "4d1b0e5f7c9a4b3d8f2e6c0a1b3d5f7e"
    app_server = _AppServer()
    terminal = _Terminal()
    _AUTO_CODEX_APP_SERVERS[session_id] = app_server  # type: ignore[assignment]
    try:
        await asyncio.wait_for(
            _codex_discover_thread_and_forward(
                session_id=session_id,
                bridge_dir=tmp_path,
                codex_ws_url="ws://127.0.0.1:1",
                codex_home=tmp_path / "codex-home",
                workspace=str(tmp_path / "workspace"),
                event_client=_Client(),  # type: ignore[arg-type]
                routing_summary="Databricks ucode profile 'oss'",
                app_server=app_server,  # type: ignore[arg-type]
                terminal_instance=terminal,  # type: ignore[arg-type]
                thread_start_timeout_seconds=120.0,
            ),
            timeout=10.0,
        )
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # The budgeted wait, then the open-ended one once the cause is recorded.
    assert wait_calls == [{"timeout": 120.0}, {"timeout": None}]
    (pending,) = pending_seen
    assert pending is not None
    if expect_early:
        # Two matching reads of the prompt, then the record's own read.
        assert terminal.reads >= 3
        assert at_deadline == []
        assert pending.code == "databricks_sign_in_pending"
    else:
        assert at_deadline == [None]
        assert pending.code == "agent_startup_pending"
    # The thread start cleared the record either way.
    assert codex_native_bridge.read_bridge_startup_error(tmp_path) is None


@pytest.mark.parametrize(
    ("role", "backend_alive", "startup_error", "expected"),
    [
        # A healthy runner-owned pane is reused as before.
        ("codex-native", True, False, True),
        ("codex-native", False, False, True),
        # Backend alive but startup still pending (e.g. a sign-in prompt): reuse.
        ("codex-native", True, True, True),
        # Backend gone after a recorded startup failure: replace on the next ensure.
        ("codex-native", False, True, False),
        # A generic terminal that merely shares the id is never the native TUI.
        ("generic", True, False, False),
    ],
)
def test_codex_terminal_reuse_requires_a_live_backend_after_a_startup_failure(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    role: str,
    backend_alive: bool,
    startup_error: bool,
    expected: bool,
) -> None:
    """
    After a recorded startup failure, a registered Codex pane with no live
    app-server is not reusable: every send would fail fast on the saved error,
    so the ensure must close it and launch again (which clears the record).
    """
    from omnigent.runner.app import _AUTO_CODEX_APP_SERVERS
    from omnigent.runner.native.orchestration import _is_runner_owned_codex_terminal
    from omnigent.runner.resource_registry import CODEX_NATIVE_TERMINAL_ROLE

    session_id = "6f2e1d0c9b8a47f6a5e4d3c2b1a09f8e"
    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    bridge_dir = codex_native_bridge.prepare_bridge_dir(session_id)
    if startup_error:
        codex_native_bridge.write_bridge_startup_error(
            bridge_dir, "Codex stopped before it could start.", code="codex_thread_not_started"
        )

    class _Registry:
        def terminal_resource_role(self, _session_id: str, _terminal_id: str) -> str | None:
            return CODEX_NATIVE_TERMINAL_ROLE if role == "codex-native" else None

    view = SessionResourceView(
        id="terminal_codex_main", type="terminal", session_id=session_id, name="Codex"
    )
    if backend_alive:
        _AUTO_CODEX_APP_SERVERS[session_id] = object()  # type: ignore[assignment]
    try:
        assert _is_runner_owned_codex_terminal(_Registry(), view) is expected  # type: ignore[arg-type]
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)


@pytest.mark.asyncio
async def test_codex_discover_thread_and_forward_persists_workspace_as_bridge_cwd(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """
    The fresh-session bridge state must carry the session workspace as ``cwd``.

    A runner-owned codex-native session's shell tools run wherever
    ``CodexNativeBridgeState.cwd`` points; when the discovery path writes the
    state without it, the Codex executor falls back to the harness process's
    own working directory (the runner service's cwd), so web-driven shell
    commands run from the wrong directory instead of the selected workspace.
    """
    from omnigent.harnesses.codex_native import forwarder as codex_native_forwarder
    from omnigent.runner.app import (
        _AUTO_CODEX_APP_SERVERS,
        _codex_discover_thread_and_forward,
    )

    thread_id = "019e96aa-abcd-7343-8d3b-6f914d60936b"
    workspace = tmp_path / "selected-workspace"
    wait_calls: list[dict[str, object]] = []
    patch_requests: list[httpx.Request] = []
    real_async_client = httpx.AsyncClient

    def _handle_patch(request: httpx.Request) -> httpx.Response:
        patch_requests.append(request)
        return httpx.Response(200, json={})

    def _mock_client(**kwargs: Any) -> httpx.AsyncClient:
        return real_async_client(transport=httpx.MockTransport(_handle_patch), **kwargs)

    async def _fake_wait(*_args: object, **kwargs: object) -> str:
        wait_calls.append(kwargs)
        return thread_id

    async def _fake_supervise(**_kwargs: object) -> None:
        return None

    class _Client:
        async def close(self) -> None:
            return None

    class _AppServer:
        async def close(self) -> None:
            return None

    monkeypatch.setattr(codex_native_forwarder, "wait_for_thread_started", _fake_wait)
    monkeypatch.setattr(codex_native_forwarder, "supervise_forwarder", _fake_supervise)
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)
    monkeypatch.setattr(httpx, "AsyncClient", _mock_client)

    session_id = "9f1f7f7bd7f24f80a621d9a3ba3fbc10"
    codex_native_bridge.write_bridge_startup_timeout(tmp_path, 120.0)
    _AUTO_CODEX_APP_SERVERS[session_id] = _AppServer()
    try:
        await _codex_discover_thread_and_forward(
            session_id=session_id,
            bridge_dir=tmp_path,
            codex_ws_url="ws://127.0.0.1:1",
            codex_home=tmp_path / "codex-home",
            workspace=str(workspace),
            event_client=_Client(),  # type: ignore[arg-type]
            routing_summary="provider 'test' (model=gpt-test)",
            thread_start_timeout_seconds=120.0,
        )
    finally:
        _AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    assert len(patch_requests) == 1
    patch_request = patch_requests[0]
    assert patch_request.method == "PATCH"
    assert patch_request.url.copy_with(query=None) == httpx.URL(
        f"http://ap.example/v1/sessions/{session_id}"
    )
    assert dict(patch_request.url.params) == {"include_usage": "false"}
    assert json.loads(patch_request.content) == {"external_session_id": thread_id}

    state = codex_native_bridge.read_bridge_state(tmp_path)
    assert state is not None
    assert state.session_id == session_id
    assert state.thread_id == thread_id
    assert state.cwd == str(workspace)
    assert wait_calls == [{"timeout": 120.0}]
    assert codex_native_bridge.read_bridge_startup_timeout(tmp_path) == 120.0


@pytest.mark.asyncio
@pytest.mark.parametrize("freshness", ["fresh", "stale"])
async def test_auto_create_codex_terminal_default_pin_requires_a_fresh_catalog(
    freshness: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A Default codex launch pins the stored default only while it is fresh.

    Mirrors the claude rule: the store never forgets an entry, so a stale
    ``isDefault`` row can name a model the account no longer serves, and
    pinning it hard-fails the launch. A fresh entry resolves the Default
    launch; a stale one defers to codex's own account default (no model
    pin) while the store re-probes in the background.
    """
    import os
    import time

    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.models import model_catalog_store
    from omnigent.runner import app as runner_app_mod
    from tests.runner.conftest import REAL_CODEX_LAUNCH_CATALOG

    session_id = "83acdbadf84d4149b2a7d7441b6966aa"
    thread_id = "019e96aa-0be2-7343-8d3b-6f914d60936c"
    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)

    # A bare subscription default shape, with the real store-backed catalog
    # serving the seeded rows; the re-probe is stubbed off the real CLI.
    monkeypatch.setattr(
        codex_app_mod,
        "resolve_native_codex_launch",
        lambda *, model, spec=None: codex_app_mod.NativeCodexLaunch(
            config_overrides=[], model=model, profile=None
        ),
    )
    monkeypatch.setattr(codex_app_mod, "codex_launch_catalog", REAL_CODEX_LAUNCH_CATALOG)
    refreshed = [{"id": "gpt-5.6-terra", "model": "gpt-5.6-terra", "isDefault": True}]

    async def _fake_probe(
        *,
        codex_path: str | None = None,
        launch: codex_app_mod.NativeCodexLaunch | None = None,
    ) -> list[dict[str, object]]:
        """
        Stand in for the real codex probe on the background refresh path.

        :param codex_path: Ignored executable override.
        :param launch: Ignored provider launch shape.
        :returns: The refreshed catalog rows.
        """
        del codex_path, launch
        return refreshed

    monkeypatch.setattr(codex_app_mod, "probe_codex_model_options", _fake_probe)
    fingerprint = codex_app_mod.codex_catalog_fingerprint(
        codex_app_mod.resolve_native_codex_launch(model=None)
    )
    model_catalog_store.write_catalog(
        "codex-native",
        fingerprint,
        [{"id": "gpt-5.4-yesterday", "model": "gpt-5.4-yesterday", "isDefault": True}],
    )
    if freshness == "stale":
        path = model_catalog_store.catalog_path("codex-native", fingerprint)
        old = time.time() - (model_catalog_store.CATALOG_STALE_AFTER_S + 60)
        os.utime(path, (old, old))

    class _SnapshotServerClient:
        """Server client returning a Default-launch resume snapshot."""

        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            """
            Return the session snapshot / item history the helper reads.

            :param url: Request path.
            :param kwargs: Request keyword arguments.
            :returns: HTTP 200 response.
            """
            del kwargs
            if url == f"/v1/sessions/{session_id}/items":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "b1649a5cbfec3f92bec12275c14f4b60",
                                "response_id": "codex_turn_1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "remember this"}],
                            }
                        ],
                        "has_more": False,
                    },
                    request=httpx.Request("GET", url),
                )
            return httpx.Response(
                200,
                json={"external_session_id": thread_id},
                request=httpx.Request("GET", url),
            )

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = (0, 145, 0)

        def __init__(self) -> None:
            """Initialize the fake app-server state."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = tmp_path / "unconfigured-codex-home"
            self.listen_url: str | None = None
            self.started = False
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """Mark the fake app-server started."""
            self.started = True

        async def close(self) -> None:
            """No-op close."""

    app_server = _FakeCodexAppServer()
    build_calls: list[dict[str, Any]] = []

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """
        Capture app-server construction.

        :param kwargs: Keyword arguments passed by the runner helper.
        :returns: Fake app-server.
        """
        build_calls.append(kwargs)
        app_server.codex_home = kwargs["codex_home"]
        return app_server

    class _UnexpectedDiscoveryClient:
        """App-server client that must not connect on a known-thread resume."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """
            :param ws_url: App-server WebSocket URL.
            :param client_name: JSON-RPC client name.
            """
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """Fail if the resume path tries to discover a fresh thread."""
            raise AssertionError("resume path must not connect discovery client")

        async def close(self) -> None:
            """No-op close."""

    async def _fake_preload_thread(
        transport: str,
        loaded_thread_id: str,
        *,
        terminal_launch_args: list[str] | None = None,
        retain_client: bool = False,
        cwd: Path | None = None,
    ) -> None:
        """
        Accept preloading of the known Codex thread.

        :param transport: App-server transport URL.
        :param loaded_thread_id: Thread id passed to ``thread/resume``.
        :param terminal_launch_args: Pass-through args, unused.
        """
        del transport, loaded_thread_id, terminal_launch_args

    async def _fake_forward_known_thread(**kwargs: Any) -> None:
        """
        Accept the known-thread forwarder invocation.

        :param kwargs: Forwarder keyword arguments.
        """
        del kwargs

    class _FakeResourceRegistry:
        """Resource registry that accepts the terminal launch."""

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
            """
            Accept the terminal launch request.

            :param session_id: Session id being launched.
            :param terminal_name: Terminal name.
            :param session_key: Terminal session key.
            :param spec: Terminal launch spec.
            :param resource_role: Private runner resource marker.
            :param parent_os_env: Inherited os env, unused.
            :returns: Terminal resource view.
            """
            del terminal_name, session_key, spec, resource_role, parent_os_env
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    monkeypatch.setattr(
        codex_app_mod, "build_codex_native_server", _fake_build_codex_native_server
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _UnexpectedDiscoveryClient)
    monkeypatch.setattr(codex_app_mod, "preload_codex_thread_for_resume", _fake_preload_thread)
    monkeypatch.setattr(runner_app_mod, "_codex_forward_known_thread", _fake_forward_known_thread)

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        executor=ExecutorSpec(type="omnigent", config={"harness": "codex-native"}),
    )
    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, _evt: None,
            agent_spec=agent_spec,
            server_client=_SnapshotServerClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    assert build_calls, "the app-server was never built"
    if freshness == "fresh":
        assert build_calls[0]["model"] == "gpt-5.4-yesterday"
    else:
        assert build_calls[0]["model"] is None, (
            f"a stale default was still pinned: {build_calls[0]['model']!r}"
        )
        task = model_catalog_store._inflight.get(("codex-native", fingerprint))
        if task is not None:
            await task
        # The background re-probe healed the store for the next launch.
        assert model_catalog_store.read_catalog("codex-native", fingerprint) == refreshed


@pytest.mark.asyncio
async def test_auto_create_codex_terminal_accepts_gateway_spelled_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A persisted override in the gateway spelling still resolves the catalog.

    The override is stored as the servable id ``databricks-gpt-5-6-sol`` while
    the catalog lists codex's own slug ``gpt-5.6-sol``. The launch translates
    between the two, so the pre-launch check must match by codex's vocabulary,
    not string equality — a raw membership test refuses a model this host serves.
    """
    import omnigent.harnesses.codex_native.app_server as codex_app_mod
    from omnigent.models import model_catalog_store
    from omnigent.runner import app as runner_app_mod
    from tests.runner.conftest import REAL_CODEX_LAUNCH_CATALOG

    session_id = "5b0c7e2a9d1f4c3b8e6a7d5f4c3b2a1e"
    thread_id = "019e96aa-0be2-7343-8d3b-6f914d60937f"
    override = "databricks-gpt-5-6-sol"
    monkeypatch.setattr(codex_native_bridge, "_BRIDGE_ROOT", tmp_path / "codex-bridge")
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path / "workspace"))
    monkeypatch.setenv("RUNNER_SERVER_URL", "http://ap.example")
    monkeypatch.delenv("DATABRICKS_CONFIG_PROFILE", raising=False)
    monkeypatch.setattr("omnigent.runner._entry._make_auth_token_factory", lambda: None)

    monkeypatch.setattr(
        codex_app_mod,
        "resolve_native_codex_launch",
        lambda *, model, spec=None: codex_app_mod.NativeCodexLaunch(
            config_overrides=[], model=model, profile=None
        ),
    )
    monkeypatch.setattr(codex_app_mod, "codex_launch_catalog", REAL_CODEX_LAUNCH_CATALOG)

    async def _fake_probe(
        *,
        codex_path: str | None = None,
        launch: codex_app_mod.NativeCodexLaunch | None = None,
    ) -> list[dict[str, object]]:
        """Stand in for the real codex probe; unused on a store hit."""
        del codex_path, launch
        return [{"id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "isDefault": True}]

    monkeypatch.setattr(codex_app_mod, "probe_codex_model_options", _fake_probe)
    fingerprint = codex_app_mod.codex_catalog_fingerprint(
        codex_app_mod.resolve_native_codex_launch(model=None)
    )
    # A fresh catalog carrying codex's own slug, not the gateway spelling.
    model_catalog_store.write_catalog(
        "codex-native",
        fingerprint,
        [{"id": "gpt-5.6-sol", "model": "gpt-5.6-sol", "isDefault": True}],
    )

    class _SnapshotServerClient:
        """Server client returning a resume snapshot with the gateway override."""

        async def get(self, url: str, **kwargs: Any) -> httpx.Response:
            """
            Return the session snapshot / item history the helper reads.

            :param url: Request path.
            :param kwargs: Request keyword arguments.
            :returns: HTTP 200 response.
            """
            del kwargs
            if url == f"/v1/sessions/{session_id}/items":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "b1649a5cbfec3f92bec12275c14f4b61",
                                "response_id": "codex_turn_1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "remember this"}],
                            }
                        ],
                        "has_more": False,
                    },
                    request=httpx.Request("GET", url),
                )
            return httpx.Response(
                200,
                json={"model_override": override, "external_session_id": thread_id},
                request=httpx.Request("GET", url),
            )

    class _FakeCodexAppServer:
        """Minimal app-server object used by ``codex_terminal_env``."""

        codex_path = "/opt/codex/bin/codex"
        codex_cli_version: tuple[int, int, int] | None = (0, 145, 0)

        def __init__(self) -> None:
            """Initialize the fake app-server state."""
            self.env = {"OPENAI_API_KEY": "sk-test"}
            self.codex_home = tmp_path / "unconfigured-codex-home"
            self.listen_url: str | None = None
            self.started = False
            self.config_overrides: list[str] = []

        async def start(self) -> None:
            """Mark the fake app-server started."""
            self.started = True

        async def close(self) -> None:
            """No-op close."""

    app_server = _FakeCodexAppServer()
    build_calls: list[dict[str, Any]] = []

    def _fake_build_codex_native_server(**kwargs: Any) -> _FakeCodexAppServer:
        """
        Capture app-server construction.

        :param kwargs: Keyword arguments passed by the runner helper.
        :returns: Fake app-server.
        """
        build_calls.append(kwargs)
        app_server.codex_home = kwargs["codex_home"]
        return app_server

    class _UnexpectedDiscoveryClient:
        """App-server client that must not connect on a known-thread resume."""

        def __init__(self, *, ws_url: str, client_name: str) -> None:
            """
            :param ws_url: App-server WebSocket URL.
            :param client_name: JSON-RPC client name.
            """
            self.ws_url = ws_url
            self.client_name = client_name

        async def connect(self) -> None:
            """Fail if the resume path tries to discover a fresh thread."""
            raise AssertionError("resume path must not connect discovery client")

        async def close(self) -> None:
            """No-op close."""

    async def _fake_preload_thread(
        transport: str,
        loaded_thread_id: str,
        *,
        terminal_launch_args: list[str] | None = None,
        retain_client: bool = False,
        cwd: Path | None = None,
    ) -> None:
        """Accept preloading of the known Codex thread."""
        del transport, loaded_thread_id, terminal_launch_args

    async def _fake_forward_known_thread(**kwargs: Any) -> None:
        """Accept the known-thread forwarder invocation."""
        del kwargs

    class _FakeResourceRegistry:
        """Resource registry that accepts the terminal launch."""

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
            """Accept the terminal launch request."""
            del terminal_name, session_key, spec, resource_role, parent_os_env
            return SessionResourceView(
                id="terminal_codex_main",
                type="terminal",
                session_id=session_id,
                name="Codex",
            )

    monkeypatch.setattr(
        codex_app_mod, "build_codex_native_server", _fake_build_codex_native_server
    )
    monkeypatch.setattr(codex_app_mod, "CodexAppServerClient", _UnexpectedDiscoveryClient)
    monkeypatch.setattr(codex_app_mod, "preload_codex_thread_for_resume", _fake_preload_thread)
    monkeypatch.setattr(runner_app_mod, "_codex_forward_known_thread", _fake_forward_known_thread)

    agent_spec = AgentSpec(
        spec_version=1,
        name="codex",
        executor=ExecutorSpec(type="omnigent", config={"harness": "codex-native"}),
    )
    try:
        await _auto_create_codex_terminal(
            session_id,
            _FakeResourceRegistry(),  # type: ignore[arg-type]
            lambda _sid, _evt: None,
            agent_spec=agent_spec,
            server_client=_SnapshotServerClient(),  # type: ignore[arg-type]
        )
        await asyncio.sleep(0)
    finally:
        runner_app_mod._AUTO_CODEX_APP_SERVERS.pop(session_id, None)

    # The gateway-spelled override was accepted (not refused) and passed
    # through to the launch, which translates it to codex's slug downstream.
    assert build_calls, "a servable override was refused as unknown"
    assert build_calls[0]["model"] == override
