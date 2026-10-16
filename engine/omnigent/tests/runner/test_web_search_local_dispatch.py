"""Blast-radius tests for routing ``web_search`` through runner-local dispatch.

These lock in the expectations behind the ``web_search`` dispatch fix: the tool
must be runner-local (so a non-OpenAI model's call resolves to its backend), and
it must NOT be advertised to native harnesses (which use their own web search).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from omnigent.runner.tool_dispatch import (
    _ALL_LOCAL_TOOLS,
    _NATIVE_RELAY_BUILTIN_TOOLS,
    _execute_web_search_tool,
    should_dispatch_locally,
)


def _spec_with_model(model: str) -> SimpleNamespace:
    """Minimal agent_spec stub: an executor model + a web_search builtin config.

    Uses the Tavily backend, the only ``search_provider`` web_search supports.
    """
    return SimpleNamespace(
        executor=SimpleNamespace(model=model),
        tools=SimpleNamespace(
            builtins=[
                SimpleNamespace(
                    name="web_search",
                    config={"search_provider": "tavily", "api_key": "k"},
                )
            ]
        ),
    )


def test_web_search_is_runner_local() -> None:
    """``web_search`` dispatches locally."""
    assert "web_search" in _ALL_LOCAL_TOOLS
    assert should_dispatch_locally("web_search") is True


def test_web_search_not_relayed_to_native_harnesses() -> None:
    """Native harnesses (claude-native / codex-native) use their own web search."""
    assert "web_search" not in _NATIVE_RELAY_BUILTIN_TOOLS


@pytest.mark.parametrize("model", ["gpt-5.4-mini", "claude-sonnet-4-6"])
def test_dispatch_runs_tavily_backend_for_any_model(model: str) -> None:
    """The handler runs the spec's Tavily backend whatever the executor model."""
    spec = _spec_with_model(model)
    fake_response = MagicMock()
    fake_response.json.return_value = {
        "answer": "answer",
        "results": [{"title": "T", "url": "https://example.com", "content": "snippet"}],
    }
    with patch("omnigent.tools.builtins.web_search_tavily.httpx.post") as mock_post:
        mock_post.return_value = fake_response
        result = asyncio.run(
            _execute_web_search_tool({"query": "x"}, agent_spec=spec, conversation_id="c")
        )
    assert mock_post.call_count == 1
    assert mock_post.call_args.kwargs["json"]["query"] == "x"
    assert result.startswith("answer")
    assert "https://example.com" in result
