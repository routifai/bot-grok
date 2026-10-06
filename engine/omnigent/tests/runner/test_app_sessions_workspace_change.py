"""The runner picks up a session's new working directory after ``workspace_change``."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from omnigent.runner import create_runner_app
from omnigent.runner import tool_dispatch as _tool_dispatch
from omnigent.spec.types import AgentSpec, LocalToolInfo
from tests.runner.conftest import _FakeProcessManager, _runner_client, _ScriptedHarnessClient, _sse
from tests.runner.helpers import NullServerClient

SESSION = "c7f36aa769270cac30144784fad50acc"
AGENT = "31ebfedf721b44dabd76f662cb70a400"


class _ServerWithWorkspace(NullServerClient):
    """A server whose session row carries a workspace the test can change."""

    def __init__(self, workspace: Path) -> None:
        self.workspace = workspace

    class _Row(NullServerClient._Response):
        def __init__(self, workspace: Path) -> None:
            self._workspace = workspace

        def json(self) -> dict[str, Any]:
            return {"workspace": str(self._workspace), "agent_id": AGENT}

    async def get(self, url: str, **kwargs: Any) -> NullServerClient._Response:
        if url.startswith("/v1/sessions/"):
            return self._Row(self.workspace)
        return await super().get(url, **kwargs)


async def test_tool_calls_use_the_new_directory_after_workspace_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Turn 1 runs in the old folder; after the event, turn 2 runs in the new one."""
    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir()
    new.mkdir()
    bundle = tmp_path / "bundle"
    (bundle / "tools" / "python").mkdir(parents=True)
    (bundle / "tools" / "python" / "probe.py").write_text(
        "from omnigent_client.tools import tool\n\n@tool\ndef probe(text: str) -> str:\n"
        "    return text\n"
    )
    spec = AgentSpec(
        spec_version=1,
        name="probe-agent",
        local_tools=[LocalToolInfo(name="probe", path="tools/python/probe.py", language="python")],
    )
    seen: list[Path | None] = []

    async def fake_dispatch(*, runner_workspace: Path | None = None, **_: Any) -> str:
        seen.append(runner_workspace)
        return "ok"

    monkeypatch.setattr(_tool_dispatch, "dispatch_tool_locally", fake_dispatch)
    frames = [
        _sse({"type": "response.created", "response": {"id": "resp_1"}}),
        _sse(
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "status": "action_required",
                    "name": "probe",
                    "call_id": "call_1",
                    "arguments": json.dumps({"text": "x"}),
                },
            }
        ),
        _sse({"type": "response.completed", "response": {"id": "resp_1"}}),
    ]
    server = _ServerWithWorkspace(old)

    async def resolver(agent_id: str, session_id: str | None = None) -> Any:
        from omnigent.runner.app import ResolvedSpec

        return ResolvedSpec(spec=spec, workdir=bundle)

    app = create_runner_app(
        process_manager=_FakeProcessManager(_ScriptedHarnessClient(frames)),  # type: ignore[arg-type]
        spec_resolver=resolver,
        server_client=server,  # type: ignore[arg-type]
        runner_workspace=tmp_path,
    )

    async def run_turn(expected_calls: int) -> None:
        resp = await client.post(
            f"/v1/sessions/{SESSION}/events",
            json={
                "type": "message",
                "role": "user",
                "agent_id": AGENT,
                "model": "probe-agent",
                "content": [{"type": "input_text", "text": "hi"}],
                "harness": "openai-agents",
            },
        )
        assert resp.status_code == 202
        for _ in range(100):
            if len(seen) >= expected_calls:
                return
            await asyncio.sleep(0.05)

    async with _runner_client(app) as client:
        await run_turn(1)
        server.workspace = new  # the server already stored it (PUT .../workspace)
        changed = await client.post(
            f"/v1/sessions/{SESSION}/events", json={"type": "workspace_change"}
        )
        assert changed.status_code == 204
        await run_turn(2)

    assert seen == [old.resolve(), new.resolve()]
