"""Built-in tool: web_fetch backed by Tavily's extract API.

A headless alternative to the sub-agent ``web_fetch`` (see ``web_fetch.py``):
one HTTPS call returns the readable text of a page, no sandbox or shell needed.

Configured in the agent spec::

    tools:
      builtins:
        - name: web_fetch
          fetch_provider: tavily
          api_key: ${TAVILY_API_KEY}
          # optional: max_chars: 20000

See https://docs.tavily.com/documentation/api-reference/endpoint/extract
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from omnigent.tools.base import Tool, ToolContext
from omnigent.tools.builtins._arguments import parse_json_object_arguments

_logger = logging.getLogger(__name__)

_DEFAULT_EXTRACT_URL = "https://api.tavily.com/extract"
_DEFAULT_MAX_CHARS = 20_000
_FETCH_PROVIDERS = frozenset({"tavily"})

_DESCRIPTION = (
    "Read the text of one web page by URL (an article, a filing, a docs page). "
    "Use it after web_search when a result's snippet is not enough. Returns the "
    "page's readable text; pages that need a login or interaction need the browser."
)


def uses_fetch_provider(config: dict[str, str] | None) -> bool:
    """
    :param config: A ``web_fetch`` builtin's spec config.
    :returns: True when it names a headless ``fetch_provider``.
    """
    return bool(config and config.get("fetch_provider"))


def _extract_url() -> str:
    """Resolve the Tavily Extract URL; ``OMNIGENT_TAVILY_EXTRACT_URL`` overrides for tests."""
    return os.environ.get("OMNIGENT_TAVILY_EXTRACT_URL", _DEFAULT_EXTRACT_URL)


class WebFetchExtractTool(Tool):
    """
    ``web_fetch`` that extracts a page's text through Tavily.

    :param config: Spec-level config: ``fetch_provider`` (``tavily``),
        ``api_key``, optional ``max_chars``.
    """

    def __init__(self, config: dict[str, str] | None = None) -> None:
        self._config = config or {}

    @classmethod
    def name(cls) -> str:
        """:returns: ``"web_fetch"``."""
        return "web_fetch"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return _DESCRIPTION

    def get_schema(self) -> dict[str, Any]:
        """:returns: OpenAI-format function schema taking a ``url``."""
        return {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": _DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "The page URL (https://...)."},
                    },
                    "required": ["url"],
                },
            },
        }

    def is_async(self, arguments: str | None = None) -> bool:
        """:returns: ``False`` — runs synchronously in the tool loop."""
        del arguments
        return False

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Fetch one page.

        :param arguments: JSON-encoded dict with a ``url`` key.
        :param ctx: Tool execution context (unused).
        :returns: The page text, or an error message.
        """
        del ctx
        parsed, error = parse_json_object_arguments(arguments)
        if error is not None:
            return f"Error: {error}"
        assert parsed is not None
        url = parsed.get("url")
        if not isinstance(url, str) or not url.strip():
            return "Error: 'url' parameter is required."
        provider = self._config.get("fetch_provider")
        if provider not in _FETCH_PROVIDERS:
            return f"web_fetch error: unknown fetch_provider {provider!r}. Use: tavily."
        api_key = self._config.get("api_key")
        if not api_key:
            return "Error: api_key must be provided in the web_fetch config in config.yaml."
        try:
            max_chars = int(self._config.get("max_chars", _DEFAULT_MAX_CHARS))
        except (TypeError, ValueError):
            max_chars = _DEFAULT_MAX_CHARS
        try:
            resp = httpx.post(
                _extract_url(),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-Client-Source": "omnigent",
                },
                json={"urls": [url.strip()], "format": "markdown", "extract_depth": "basic"},
                timeout=45.0,
            )
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            return f"web_fetch error: HTTP {exc.response.status_code}"
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            return f"web_fetch error: {exc}"
        return _format_extract(resp.json(), max_chars)


def _format_extract(data: dict[str, Any], max_chars: int) -> str:
    """
    Format Tavily's ``/extract`` response.

    :param data: Parsed JSON: ``{"results": [{"url", "raw_content"}], "failed_results": [...]}``.
    :param max_chars: Truncation limit for the page text.
    :returns: The page text, or a readable failure.
    """
    results = data.get("results") or []
    if not results:
        failed = data.get("failed_results") or []
        reason = failed[0].get("error") if failed and isinstance(failed[0], dict) else None
        return f"web_fetch could not read that page{f': {reason}' if reason else '.'}"
    item = results[0]
    text = str(item.get("raw_content") or "").strip()
    if not text:
        return "web_fetch found no readable text on that page."
    if len(text) > max_chars:
        text = text[:max_chars] + "\n\n[truncated]"
    return f"{item.get('url', '')}\n\n{text}"
