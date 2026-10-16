"""Session ownership and harness transport for disposable sandbox writes."""

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from omnigent.inner.datamodel import OSEnvSandboxSpec, OSEnvSpec, WritePathSpec
from omnigent.runner.resource_registry import SessionResourceRegistry


@pytest.fixture
def spec(tmp_path):
    return SimpleNamespace(
        os_env=OSEnvSpec(
            cwd=str(tmp_path),
            sandbox=OSEnvSandboxSpec(type="linux_bwrap", write_paths=[WritePathSpec(".", True)]),
        )
    )


def test_filesystem_panel_default_is_upgraded_before_cow_tools(spec, tmp_path, monkeypatch):
    registry = SessionResourceRegistry(runner_workspace=tmp_path)
    default = Mock(sandbox=SimpleNamespace(copy_on_write_roots=None))
    shared = Mock(sandbox=SimpleNamespace(copy_on_write_roots=[tmp_path]))
    factory = Mock(side_effect=[default, shared])
    monkeypatch.setattr(registry, "_create_primary_env", factory)
    assert registry._resolve_primary("session", None) is default
    assert registry._resolve_primary("session", spec) is shared
    default.close.assert_called_once()
    assert registry._resolve_primary("session", spec) is shared
    assert registry._resolve_primary("session", None) is shared
    assert factory.call_count == 2


def test_session_cannot_silently_change_copy_on_write_configuration(spec, tmp_path, monkeypatch):
    registry = SessionResourceRegistry(runner_workspace=tmp_path)
    shared = Mock(sandbox=SimpleNamespace(copy_on_write_roots=[tmp_path]))
    monkeypatch.setattr(registry, "_create_primary_env", Mock(return_value=shared))
    registry._resolve_primary("session", spec)
    changed = SimpleNamespace(os_env=replace(spec.os_env, sandbox=OSEnvSandboxSpec(type="none")))
    with pytest.raises(ValueError, match="new session"):
        registry._resolve_primary("session", changed)
    shared.close.assert_not_called()


@pytest.mark.asyncio
async def test_terminal_consumers_close_before_owner(spec, tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    closed = []
    terminals = Mock()
    terminals.cleanup_conversation = AsyncMock(side_effect=lambda *a: closed.append("terminals"))
    registry = SessionResourceRegistry(terminal_registry=terminals, runner_workspace=tmp_path)
    shared = Mock()
    shared.close.side_effect = lambda: closed.append("owner")
    monkeypatch.setattr(registry, "_create_primary_env", Mock(return_value=shared))
    registry._resolve_primary("session", spec)
    await registry.cleanup_session("session")
    assert closed == ["terminals", "owner"]
    assert "session" not in registry._primary_env_specs


@pytest.mark.parametrize("cwd", [None, "", ".", "./"])
@pytest.mark.parametrize("terminal_first", [False, True])
def test_terminal_materialization_keeps_same_environment(
    spec, tmp_path, monkeypatch, cwd, terminal_first
):
    from omnigent.tools.builtins.sys_terminal import _synthesize_parent_os_env

    agent = SimpleNamespace(os_env=replace(spec.os_env, cwd=cwd))
    parent = _synthesize_parent_os_env(agent.os_env, str(tmp_path))
    registry = SessionResourceRegistry(runner_workspace=tmp_path)
    shared = Mock(sandbox=SimpleNamespace(copy_on_write_roots=[tmp_path]))
    factory = Mock(return_value=shared)
    monkeypatch.setattr(registry, "_create_primary_env", factory)
    if terminal_first:
        assert registry._resolve_terminal_environment("session", parent) is shared
    assert registry._resolve_primary("session", agent) is shared
    assert registry._resolve_terminal_environment("session", parent) is shared
    factory.assert_called_once()


@pytest.mark.parametrize("harness", ["codex-native", "claude-sdk", "pi", "unknown"])
def test_unsupported_harness_rejected_before_spawn(spec, harness):
    from omnigent.runner.app import _build_spawn_env_from_spec
    from omnigent.spec.types import AgentSpec, ExecutorSpec

    agent = AgentSpec(
        spec_version=1,
        name="cow",
        os_env=spec.os_env,
        executor=ExecutorSpec(type="omnigent", config={"harness": harness}),
    )
    with pytest.raises(ValueError, match="copy_on_write"):
        _build_spawn_env_from_spec(agent, harness)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args",
    [
        ("upload_file", {"path": "original"}),
        ("sys_agent_download", {"session_id": "session"}),
        ("sys_agent_list", {}),
        ("load_skill", {"name": "example"}),
        ("read_skill_file", {"path": "example"}),
        ("sys_session_create", {"config_path": "agent.yaml"}),
    ],
)
async def test_host_filesystem_tools_rejected_in_cow_session(spec, name, args):
    import json
    from unittest.mock import AsyncMock

    from omnigent.runner.tool_dispatch import execute_tool

    client = AsyncMock()
    result = await execute_tool(
        tool_name=name,
        arguments=json.dumps(args),
        agent_spec=spec,
        conversation_id="session",
        server_client=client,
    )
    assert "does not yet support copy_on_write" in result
    client.get.assert_not_called()
    client.post.assert_not_called()


@pytest.mark.asyncio
async def test_cached_cow_still_rejects_host_io_when_spec_unavailable(spec, tmp_path, monkeypatch):
    from omnigent.runner.tool_dispatch import execute_tool

    registry = SessionResourceRegistry(runner_workspace=tmp_path)
    shared = Mock(sandbox=SimpleNamespace(copy_on_write_roots=[tmp_path]))
    monkeypatch.setattr(registry, "_create_primary_env", Mock(return_value=shared))
    registry._resolve_primary("session", spec)
    result = await execute_tool(
        tool_name="upload_file",
        arguments='{"path":"original"}',
        agent_spec=None,
        resource_registry=registry,
        conversation_id="session",
    )
    assert "does not yet support copy_on_write" in result


@pytest.mark.asyncio
async def test_tool_grant_probe_keeps_session_relative_cow_configuration(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from omnigent.runner import tool_dispatch
    from omnigent.spec.types import AgentSpec, BuiltinToolConfig, ExecutorSpec, ToolsConfig

    workspace = tmp_path / "workspace"
    (workspace / "dependencies").mkdir(parents=True)
    runner = tmp_path / "runner"
    runner.mkdir()
    monkeypatch.chdir(runner)
    os_spec = OSEnvSpec(
        cwd=".",
        sandbox=OSEnvSandboxSpec(
            type="linux_bwrap", write_paths=[WritePathSpec("dependencies", True)]
        ),
    )
    agent = AgentSpec(
        spec_version=1,
        os_env=os_spec,
        tools=ToolsConfig(builtins=[BuiltinToolConfig(name="upload_file")]),
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-sdk"}),
    )
    execute = AsyncMock(return_value="session file")
    monkeypatch.setattr(tool_dispatch, "_execute_os_env_tool", execute)
    result = await tool_dispatch.execute_tool(
        tool_name="sys_os_read",
        arguments='{"path":"dependencies/original"}',
        agent_spec=agent,
        conversation_id="session",
        runner_workspace=str(workspace),
    )
    assert result == "session file"
    assert execute.call_args.kwargs["agent_spec"].os_env is os_spec
    assert os_spec.sandbox is not None
    assert os_spec.sandbox.write_path_specs == [WritePathSpec("dependencies", True)]
    refused = await tool_dispatch.execute_tool(
        tool_name="upload_file",
        arguments='{"path":"dependencies/original"}',
        agent_spec=agent,
        conversation_id="session",
    )
    assert "does not yet support copy_on_write" in refused


@pytest.mark.asyncio
@pytest.mark.parametrize("harness", ["claude-sdk", "pi"])
async def test_stream_setup_errors_are_sanitized_before_spawn(
    spec, tmp_path, monkeypatch, harness
):
    from omnigent.runner import create_runner_app
    from omnigent.spec.types import AgentSpec, ExecutorSpec
    from tests.runner.conftest import _FakeProcessManager, _runner_client, _ScriptedHarnessClient
    from tests.runner.helpers import NullServerClient

    agent = AgentSpec(
        spec_version=1,
        name="cow",
        os_env=spec.os_env,
        executor=ExecutorSpec(type="omnigent", config={"harness": "claude-sdk"}),
    )

    async def resolver(agent_id, session_id=None):
        return agent

    registry = SessionResourceRegistry(runner_workspace=tmp_path)
    environment = Mock(sandbox=object())
    environment.prepare_sandbox.side_effect = ValueError("private diagnostic sentinel")
    monkeypatch.setattr(registry, "_create_primary_env", Mock(return_value=environment))
    manager = _FakeProcessManager(_ScriptedHarnessClient([]))
    app = create_runner_app(
        process_manager=manager,
        spec_resolver=resolver,
        server_client=NullServerClient(),
        resource_registry=registry,
    )
    async with _runner_client(app) as client:
        response = await client.post(
            "/v1/sessions/cow-stream/events?stream=true",
            json={
                "type": "message",
                "role": "user",
                "harness": harness,
                "agent_id": "agent",
                "content": [{"type": "input_text", "text": "Read the workspace"}],
            },
        )
    assert response.status_code == 400, response.text
    assert response.json()["error"] == "copy_on_write_setup_failed"
    assert "private diagnostic sentinel" not in response.text
    assert not manager.get_client_calls
