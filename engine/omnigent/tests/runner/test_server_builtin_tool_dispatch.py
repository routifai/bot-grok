"""Tests for routing Nova's ``nova_*`` builtins through the server proxy.

Before this, ``execute_tool`` had no branch for ``nova_*`` names: they fell
through to the spec-callable fallback and errored ``"<tool> not in local
dispatch table"`` (Nova's tools need the Omnigent database, which a runner
process has no access to). These lock in that the tools proxy to
``POST /v1/sessions/{id}/builtin-tools/execute`` instead of being dispatched
in-process, and that they are advertised to native harnesses via the relay.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from omnigent.runner.tool_dispatch import (
    _ALL_LOCAL_TOOLS,
    _NATIVE_RELAY_BUILTIN_TOOLS,
    _execute_server_builtin_tool,
    execute_tool,
    should_dispatch_locally,
)
from omnigent.tools.builtins import SERVER_BUILTIN_NAMES


def _spec(name: str = "nova_remember") -> SimpleNamespace:
    return SimpleNamespace(
        executor=SimpleNamespace(model="claude-opus-4-8"),
        tools=SimpleNamespace(builtins=[SimpleNamespace(name=name, config={})]),
        local_tools=[],
    )


class _Resp:
    def __init__(self, *, status_code: int = 200, body: object | None = None) -> None:
        self.status_code = status_code
        self._body = body if body is not None else {}

    @property
    def text(self) -> str:
        return json.dumps(self._body)

    def json(self) -> object:
        return self._body


class _RecordingClient:
    """Records each POST's url/json and returns a scripted response."""

    def __init__(self, response: _Resp | None = None) -> None:
        self.calls: list[tuple[str, dict[str, object] | None]] = []
        self._response = response or _Resp(body={"output": json.dumps({"ok": True})})

    async def post(self, url: str, *, json: dict | None = None, timeout: object = None) -> _Resp:
        self.calls.append((url, json))
        return self._response


def test_server_builtin_names_is_exactly_novas_tools() -> None:
    expected = {
        "nova_remember",
        "nova_ask_user",
        "nova_recall_episodes",
        "nova_goals",
        "nova_offer_skill",
        "nova_save_skill",
        "nova_load_skill",
        "nova_follow_topic",
        "nova_unfollow_topic",
        "nova_post_to_feed",
    }
    assert expected == SERVER_BUILTIN_NAMES


@pytest.mark.parametrize("name", sorted(SERVER_BUILTIN_NAMES))
def test_nova_tools_are_runner_local(name: str) -> None:
    """Runner-local == proxied to the server, not dispatched to the client."""
    assert name in _ALL_LOCAL_TOOLS
    assert should_dispatch_locally(name) is True


@pytest.mark.parametrize("name", sorted(SERVER_BUILTIN_NAMES))
def test_nova_tools_relayed_to_native_harnesses(name: str) -> None:
    """Otherwise claude-native/codex-native/pi-native never see them at all —
    the relay is their only tool surface."""
    assert name in _NATIVE_RELAY_BUILTIN_TOOLS


@pytest.mark.asyncio
async def test_execute_server_builtin_tool_posts_to_session_endpoint() -> None:
    client = _RecordingClient(_Resp(body={"output": '{"ok": true, "id": "note_1"}'}))
    out = await _execute_server_builtin_tool(
        "nova_remember",
        json.dumps({"content": "likes oat milk"}),
        server_client=client,
        conversation_id="conv_abc",
    )
    url, body = client.calls[0]
    assert url == "/v1/sessions/conv_abc/builtin-tools/execute"
    assert body == {
        "tool_name": "nova_remember",
        "arguments": json.dumps({"content": "likes oat milk"}),
    }
    assert out == '{"ok": true, "id": "note_1"}'


@pytest.mark.asyncio
async def test_execute_server_builtin_tool_no_server_client_errors() -> None:
    out = await _execute_server_builtin_tool(
        "nova_remember", "{}", server_client=None, conversation_id="conv_abc"
    )
    assert "requires server access" in json.loads(out)["error"]


@pytest.mark.asyncio
async def test_execute_server_builtin_tool_no_conversation_id_errors() -> None:
    client = _RecordingClient()
    out = await _execute_server_builtin_tool(
        "nova_remember", "{}", server_client=client, conversation_id=None
    )
    assert "requires an active session" in json.loads(out)["error"]
    assert client.calls == []


@pytest.mark.asyncio
async def test_execute_server_builtin_tool_server_error_becomes_clean_json() -> None:
    client = _RecordingClient(_Resp(status_code=403, body={"error": "not the owner"}))
    out = await _execute_server_builtin_tool(
        "nova_remember", "{}", server_client=client, conversation_id="conv_abc"
    )
    assert "server returned 403" in json.loads(out)["error"]


@pytest.mark.asyncio
async def test_nova_remember_is_forwarded_not_local_dispatch_table_error() -> None:
    """Regression: this used to error `nova_remember not in local dispatch table`
    (see docstring of ``execute_tool``'s spec-callable fallback)."""
    client = _RecordingClient(_Resp(body={"output": '{"ok": true}'}))
    out = await execute_tool(
        tool_name="nova_remember",
        arguments=json.dumps({"content": "likes oat milk"}),
        server_client=client,
        agent_spec=_spec(),
        conversation_id="conv_abc",
    )
    assert "not in local dispatch table" not in out
    assert out == '{"ok": true}'
    url, body = client.calls[0]
    assert url == "/v1/sessions/conv_abc/builtin-tools/execute"
    assert body is not None
    assert body["tool_name"] == "nova_remember"
