"""Built-in tools for suggestions (Ideas: concrete next steps for the person).

Schema-only classes: the runner dispatches each to the server's
``/v1/suggestions`` REST endpoints (see ``_execute_suggestion_tool``).

* ``suggestion_create`` — record one Idea under the chat (any caller, including a Helper).
* ``suggestion_list`` — read the chat's open Ideas, to avoid proposing duplicates.
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

SUGGESTION_TOOL_NAMES = ("suggestion_create", "suggestion_list")


class _SuggestionTool(Tool):
    _NAME = ""
    _DESC = ""
    _PROPERTIES: dict[str, Any] = {}
    _REQUIRED: tuple[str, ...] = ()

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return cls._NAME

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return cls._DESC

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": self._PROPERTIES,
                    "required": list(self._REQUIRED),
                    "additionalProperties": False,
                },
            },
        }


class SuggestionCreateTool(_SuggestionTool):
    """Record an Idea; dispatched to ``POST /v1/suggestions``."""

    _NAME = "suggestion_create"
    _DESC = (
        "Record one Idea: a concrete thing the assistant could do for the person next. "
        "The person sees it as a card and can accept it, which sends `message` to the chat. "
        "Call once per Idea; never duplicate an open one."
    )
    _PROPERTIES = {
        "title": {"type": "string", "description": "Short headline, at most 8 words."},
        "why": {"type": "string", "description": "One line: why this is worth doing now."},
        "message": {
            "type": "string",
            "description": (
                "The exact message the person would send to ask for this, written in "
                "their voice, specific enough to act on without more questions."
            ),
        },
    }
    _REQUIRED = ("title", "why", "message")


class SuggestionListTool(_SuggestionTool):
    """List this chat's open Ideas; dispatched to ``GET /v1/suggestions``."""

    _NAME = "suggestion_list"
    _DESC = "List the Ideas already waiting for the person, so you do not repeat them."
