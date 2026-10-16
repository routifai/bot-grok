"""Tests for the ``web_search`` built-in tool (Tavily backend)."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from omnigent.tools.base import ToolContext
from omnigent.tools.builtins import get_builtin_tool
from omnigent.tools.builtins.web_search import WebSearchTool
from omnigent.tools.builtins.web_search_tavily import (
    _resolve_max_results as _resolve_max_results_tavily,
)

# ── Registry ─────────────────────────────────────────


def test_get_builtin_tool_returns_web_search() -> None:
    """``get_builtin_tool("web_search")`` returns a WebSearchTool."""
    tool = get_builtin_tool("web_search")
    assert isinstance(tool, WebSearchTool), f"Expected WebSearchTool, got {type(tool).__name__}."


def test_get_builtin_tool_unknown_returns_none() -> None:
    """``get_builtin_tool`` returns ``None`` for unregistered names."""
    assert get_builtin_tool("nonexistent") is None


# ── Schema and argument validation ──────────────────


def test_schema_is_function() -> None:
    """The schema is a standard function schema requiring ``query``."""
    schema = WebSearchTool().get_schema()
    assert schema["type"] == "function"
    func = schema["function"]
    assert func["name"] == "web_search"
    assert "query" in func["parameters"]["required"]


def test_missing_query_returns_error(tool_ctx: ToolContext) -> None:
    """Tool returns error when query param is missing."""
    tool = WebSearchTool(config={"search_provider": "tavily", "api_key": "k"})
    result = tool.invoke(json.dumps({}), tool_ctx)
    assert "query" in result.lower()


def test_invalid_arguments_return_error(tool_ctx: ToolContext) -> None:
    """Malformed and non-object JSON return tool errors instead of raising."""
    tool = WebSearchTool()
    malformed = tool.invoke("{", tool_ctx)
    non_object = tool.invoke("[]", tool_ctx)
    assert "Error" in malformed and "malformed JSON" in malformed
    assert "Error" in non_object and "JSON object" in non_object


@pytest.mark.parametrize("query", [123, True, "  "])
def test_invalid_query_returns_error(tool_ctx: ToolContext, query: object) -> None:
    """Invalid queries are rejected before the backend is called."""
    tool = WebSearchTool()
    result = tool.invoke(json.dumps({"query": query}), tool_ctx)
    assert "Error" in result and "query" in result.lower()


# ── search_provider: tavily ──────────────────────────


def test_tavily_backend_via_spec_config(tool_ctx: ToolContext) -> None:
    """
    With search_provider=tavily and api_key in spec config,
    the tool delegates to Tavily web search.
    """
    fake_response = MagicMock()
    fake_response.json.return_value = {
        "results": [
            {
                "title": "Tavily Docs",
                "url": "https://docs.tavily.com",
                "content": "Search API for agents.",
            },
        ],
        "answer": None,
    }

    tool = WebSearchTool(
        config={
            "search_provider": "tavily",
            "api_key": "spec-tavily-key",
        },
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = tool.invoke(json.dumps({"query": "tavily"}), tool_ctx)

    # Tavily result list made it through the unified tool pipeline.
    assert "1. Tavily Docs" in result
    assert "https://docs.tavily.com" in result
    assert "Search API for agents." in result


def test_tavily_answer_shown_first_when_present(tool_ctx: ToolContext) -> None:
    """A non-null ``answer`` is shown before the result list."""
    fake_response = MagicMock()
    fake_response.json.return_value = {
        "answer": "Tavily is a search API for AI agents.",
        "results": [
            {"title": "Home", "url": "https://tavily.com", "content": "..."},
        ],
    }

    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "k"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = tool.invoke(json.dumps({"query": "tavily"}), tool_ctx)

    assert result.startswith("Tavily is a search API for AI agents.")
    assert "1. Home" in result


def test_tavily_missing_key_returns_error(tool_ctx: ToolContext) -> None:
    """With search_provider=tavily but no api_key, returns error."""
    tool = WebSearchTool(
        config={"search_provider": "tavily"},
    )
    result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert "api_key" in result


def test_tavily_spec_config_used_in_http_call(tool_ctx: ToolContext) -> None:
    """
    api_key from spec config is sent as a Bearer header, and the
    request body carries query / max_results / search_depth.
    """
    fake_response = MagicMock()
    fake_response.json.return_value = {"results": []}

    tool = WebSearchTool(
        config={
            "search_provider": "tavily",
            "api_key": "spec-tavily",
            "max_results": "7",
        },
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        tool.invoke(json.dumps({"query": "test"}), tool_ctx)

    headers = mock_post.call_args.kwargs["headers"]
    assert headers["Authorization"] == "Bearer spec-tavily", (
        f"Expected spec config api_key in header, got {headers['Authorization']!r}"
    )
    body = mock_post.call_args.kwargs["json"]
    assert body["query"] == "test"
    # max_results comes from config as a str ("7") and must be coerced to int.
    assert body["max_results"] == 7, f"Expected int 7, got {body['max_results']!r}"
    # Default tier is 'basic'.
    assert body["search_depth"] == "basic"


def test_tavily_sends_x_client_source_header(tool_ctx: ToolContext) -> None:
    """Every request carries the ``X-Client-Source`` header identifying Omnigent."""
    fake_response = MagicMock()
    fake_response.json.return_value = {"results": []}

    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "spec-tavily"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        tool.invoke(json.dumps({"query": "test"}), tool_ctx)

    headers = mock_post.call_args.kwargs["headers"]
    assert headers["X-Client-Source"] == "omnigent", (
        f"Expected X-Client-Source 'omnigent', got {headers.get('X-Client-Source')!r}"
    )


def test_tavily_http_error_returns_error_string(tool_ctx: ToolContext) -> None:
    """An HTTP error (e.g. 401) is returned as a string, never raised."""
    fake_response = MagicMock()
    fake_response.status_code = 401
    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "k"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.side_effect = httpx.HTTPStatusError(
            "401", request=MagicMock(), response=fake_response
        )
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert "Tavily search error" in result
    assert "401" in result


def test_tavily_empty_results_returns_no_results(tool_ctx: ToolContext) -> None:
    """An empty result list with no answer returns the no-results message."""
    fake_response = MagicMock()
    fake_response.json.return_value = {"results": [], "answer": None}
    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "k"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert result == "No results found."


def test_tavily_answer_kept_when_no_results(tool_ctx: ToolContext) -> None:
    """A non-null ``answer`` is returned even when ``results`` is empty."""
    fake_response = MagicMock()
    fake_response.json.return_value = {"answer": "Direct answer.", "results": []}
    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "k"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert result == "Direct answer.", f"Answer must not be dropped, got {result!r}"


def test_tavily_rejects_unsupported_search_depth(tool_ctx: ToolContext) -> None:
    """An unsupported ``search_depth`` is rejected with a clear error, no HTTP call."""
    tool = WebSearchTool(
        config={"search_provider": "tavily", "api_key": "k", "search_depth": "fast"},
    )
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert "search_depth" in result
    assert mock_post.call_count == 0, "Must not call the API for an invalid search_depth."


def test_tavily_max_results_clamped() -> None:
    """``max_results`` is coerced + clamped to Tavily's 1-20 range; junk → default."""
    assert _resolve_max_results_tavily({}) == 5  # missing → default
    assert _resolve_max_results_tavily({"max_results": "0"}) == 1  # below min → clamped up
    assert _resolve_max_results_tavily({"max_results": "500"}) == 20  # above max → clamped down
    assert _resolve_max_results_tavily({"max_results": "abc"}) == 5  # non-numeric → default


# ── search_provider validation ───────────────────────


def test_unknown_search_provider_fails_loudly(tool_ctx: ToolContext) -> None:
    """A stale non-Tavily ``search_provider`` is rejected without an HTTP call."""
    tool = WebSearchTool(config={"search_provider": "other", "api_key": "k"})
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert result.startswith("web_search error: unknown search_provider 'other'")
    assert "'tavily'" in result
    assert mock_post.call_count == 0


def test_no_search_provider_uses_tavily(tool_ctx: ToolContext) -> None:
    """Without ``search_provider`` the tool runs Tavily with the spec key."""
    fake_response = MagicMock()
    fake_response.json.return_value = {"answer": "Direct answer.", "results": []}
    tool = WebSearchTool(config={"api_key": "k"})
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = tool.invoke(json.dumps({"query": "test"}), tool_ctx)
    assert result == "Direct answer."
    assert mock_post.call_count == 1


def test_no_config_requires_api_key(tool_ctx: ToolContext) -> None:
    """With no config at all the tool asks for an ``api_key``."""
    result = WebSearchTool().invoke(json.dumps({"query": "test"}), tool_ctx)
    assert "api_key" in result


def test_tool_name_is_web_search() -> None:
    """Tool name is 'web_search'."""
    assert WebSearchTool.name() == "web_search"


# ── Async dispatch contract ───────────────────────────────────────────────


def test_web_search_is_sync() -> None:
    """``web_search`` always runs through the synchronous ``invoke`` path."""
    tool = WebSearchTool(config={"search_provider": "tavily", "api_key": "k"})
    assert tool.is_async() is False
