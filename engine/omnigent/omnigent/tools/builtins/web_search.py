"""Built-in tool: web search.

Runs a Tavily search with the credentials named in the spec. No env var
fallbacks — the spec is self-contained.

Usage in config.yaml::

    tools:
      builtins:
        - name: web_search
          search_provider: tavily
          api_key: ${TAVILY_API_KEY}
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool, ToolContext
from omnigent.tools.builtins._arguments import parse_json_object_arguments
from omnigent.tools.builtins.web_search_tavily import _search_tavily

# The only supported ``search_provider``. The key is optional in the spec;
# any other value is rejected so a stale spec fails loudly.
_SEARCH_PROVIDER = "tavily"

_DESCRIPTION = (
    "Search the web for current results: facts, prices, news, lookups. Returns "
    "result titles, links and snippets."
)


class WebSearchTool(Tool):
    """
    Web search tool backed by Tavily.

    :param config: Spec-level config from config.yaml, e.g.
        ``{"search_provider": "tavily", "api_key": "tvly-..."}``.
    """

    def __init__(self, config: dict[str, str] | None = None) -> None:
        """
        Create a web search tool.

        :param config: Spec-level config with ``api_key`` and optional
            ``search_provider`` / Tavily tuning keys.
        """
        self._config = config or {}

    @classmethod
    def name(cls) -> str:
        """
        :returns: ``"web_search"``.
        """
        return "web_search"

    @classmethod
    def description(cls) -> str:
        """
        :returns: Human-readable description of the tool.
        """
        return _DESCRIPTION

    def get_schema(self) -> dict[str, Any]:
        """
        Return the function-tool schema.

        :returns: OpenAI-format tool schema dict.
        """
        return {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": _DESCRIPTION,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query.",
                        },
                    },
                    "required": ["query"],
                },
            },
        }

    def is_async(self, arguments: str | None = None) -> bool:
        """
        Run web_search synchronously in the parent's tool loop.

        :param arguments: Ignored — async-ness is a property of
            this tool, not the per-call arguments.
        :returns: ``False`` — web_search always runs synchronously.
        """
        del arguments
        return False

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Execute a web search query.

        :param arguments: JSON-encoded dict with a ``query`` key.
        :param ctx: Tool execution context.
        :returns: Search results or an error message.
        """
        parsed, error = parse_json_object_arguments(arguments)
        if error is not None:
            return f"Error: {error}"
        assert parsed is not None
        query = parsed.get("query")
        if not isinstance(query, str) or not query.strip():
            return "Error: 'query' parameter is required."
        return _search(query.strip(), self._config)


def _search(query: str, config: dict[str, str]) -> str:
    """
    Run a Tavily web search using spec config credentials.

    :param query: The search query string.
    :param config: Spec-level config: ``api_key`` (required) and an
        optional ``search_provider`` that must be ``"tavily"``.
    :returns: Search results, or an error message.
    """
    provider = config.get("search_provider")
    if provider and provider != _SEARCH_PROVIDER:
        return (
            f"web_search error: unknown search_provider {provider!r}. "
            f"The only supported search_provider is {_SEARCH_PROVIDER!r}."
        )
    if not config.get("api_key"):
        return "Tavily web search requires api_key in the web_search config."
    return _search_tavily(query, config)
