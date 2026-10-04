"""Tests for the headless Tavily-backed ``web_fetch`` (``fetch_provider: tavily``)."""

from __future__ import annotations

import json

import httpx
import pytest

from omnigent.tools.base import ToolContext
from omnigent.tools.builtins.web_fetch_tavily import (
    WebFetchExtractTool,
    uses_fetch_provider,
)

_CTX = ToolContext(task_id="t", agent_id="a", conversation_id="c")
_CONFIG = {"fetch_provider": "tavily", "api_key": "tvly-test"}


def _fake_post(response: httpx.Response, seen: dict[str, object]):
    def post(url: str, **kwargs: object) -> httpx.Response:
        seen["url"] = url
        seen.update(kwargs)
        return response

    return post


def test_uses_fetch_provider() -> None:
    assert uses_fetch_provider(_CONFIG)
    assert not uses_fetch_provider({})
    assert not uses_fetch_provider(None)


def test_schema_takes_a_url() -> None:
    params = WebFetchExtractTool(_CONFIG).get_schema()["function"]["parameters"]
    assert params["required"] == ["url"]


def test_returns_page_text(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}
    body = {"results": [{"url": "https://e.com/a", "raw_content": "Hello page"}]}
    req = httpx.Request("POST", "https://api.tavily.com/extract")
    monkeypatch.setattr(
        httpx, "post", _fake_post(httpx.Response(200, json=body, request=req), seen)
    )
    out = WebFetchExtractTool(_CONFIG).invoke(json.dumps({"url": "https://e.com/a"}), _CTX)
    assert "Hello page" in out
    assert seen["json"]["urls"] == ["https://e.com/a"]
    assert seen["headers"]["Authorization"] == "Bearer tvly-test"


def test_truncates_long_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"results": [{"url": "u", "raw_content": "x" * 500}]}
    req = httpx.Request("POST", "https://api.tavily.com/extract")
    monkeypatch.setattr(httpx, "post", _fake_post(httpx.Response(200, json=body, request=req), {}))
    tool = WebFetchExtractTool({**_CONFIG, "max_chars": "100"})
    out = tool.invoke(json.dumps({"url": "https://e.com"}), _CTX)
    assert out.endswith("[truncated]")
    assert len(out) < 200


def test_failed_extraction_is_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"results": [], "failed_results": [{"url": "u", "error": "blocked"}]}
    req = httpx.Request("POST", "https://api.tavily.com/extract")
    monkeypatch.setattr(httpx, "post", _fake_post(httpx.Response(200, json=body, request=req), {}))
    out = WebFetchExtractTool(_CONFIG).invoke(json.dumps({"url": "https://e.com"}), _CTX)
    assert "blocked" in out


def test_requires_url_and_key() -> None:
    assert "url" in WebFetchExtractTool(_CONFIG).invoke("{}", _CTX)
    out = WebFetchExtractTool({"fetch_provider": "tavily"}).invoke(
        json.dumps({"url": "https://e.com"}), _CTX
    )
    assert "api_key" in out


def test_manager_builds_extract_tool_for_fetch_provider() -> None:
    from omnigent.spec.types import BuiltinToolConfig
    from omnigent.tools.manager import ToolManager
    from tests.tools.test_manager import _make_spec

    spec = _make_spec()
    spec.tools.builtins = [BuiltinToolConfig(name="web_fetch", config=_CONFIG)]
    tool = ToolManager(spec)._tools["web_fetch"]
    assert isinstance(tool, WebFetchExtractTool)
    assert not spec.sub_agents


def test_parser_reads_tools_allow() -> None:
    from omnigent.spec.parser import _parse_tools_config

    assert _parse_tools_config({"allow": ["web_search", "browser_*"]}).allow == [
        "web_search",
        "browser_*",
    ]
    assert _parse_tools_config({}).allow is None


@pytest.mark.asyncio
async def test_dispatch_uses_extract_tool_not_the_researcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from types import SimpleNamespace

    from omnigent.runner.tool_dispatch import _execute_web_fetch_tool

    body = {"results": [{"url": "https://e.com", "raw_content": "Body text"}]}
    req = httpx.Request("POST", "https://api.tavily.com/extract")
    monkeypatch.setattr(httpx, "post", _fake_post(httpx.Response(200, json=body, request=req), {}))
    spec = SimpleNamespace(
        tools=SimpleNamespace(builtins=[SimpleNamespace(name="web_fetch", config=_CONFIG)])
    )
    out = await _execute_web_fetch_tool(
        {"url": "https://e.com"},
        server_client=None,
        conversation_id="c",
        agent_spec=spec,  # type: ignore[arg-type]
        task_id="t",
    )
    assert "Body text" in out
