"""``start_helper`` tool definition (schema only; the runner handles the call)."""

from __future__ import annotations

from typing import Any

from omnigent.superchat.subagents import HELPER_EFFORT_CHOICES, HELPER_MODEL_CHOICES
from omnigent.tools.base import Tool

START_HELPER_TOOL_NAME = "start_helper"
MESSAGE_HELPER_TOOL_NAME = "message_helper"


class StartHelperTool(Tool):
    """Start one Helper on a self-contained task; dispatched by the runner."""

    @classmethod
    def name(cls) -> str:
        """:returns: ``"start_helper"``."""
        return START_HELPER_TOOL_NAME

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Start a Helper on one self-contained piece of work. It runs on its own and its "
            "result arrives here as a message when it finishes. `task` is the whole brief: what "
            "to do, the outcome wanted, constraints and every detail it needs (it does not see "
            "this conversation). One call per Helper; call it more than once in the same step to "
            "run several in parallel. Never call it twice for the same task."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task": {
                            "type": "string",
                            "description": "The complete brief for the Helper.",
                        },
                        "title": {
                            "type": "string",
                            "description": (
                                "A short title the person will read for this work, 3 to 6 "
                                "words, in their terms (e.g. 'Counting words in your PDFs'). "
                                "Not the brief."
                            ),
                        },
                        "model": {
                            "type": "string",
                            "enum": list(HELPER_MODEL_CHOICES),
                            "default": "strong",
                            "description": (
                                "fast: lookups, extraction, form filling. strong: judgment, "
                                "synthesis, writing."
                            ),
                        },
                        "reasoning": {
                            "type": "string",
                            "enum": list(HELPER_EFFORT_CHOICES),
                            "description": "How hard it should think. Omit for the default.",
                        },
                        "files": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Ids of uploaded files to hand to the Helper.",
                        },
                    },
                    "required": ["task"],
                    "additionalProperties": False,
                },
            },
        }


class MessageHelperTool(Tool):
    """Pass a message on to a Helper that is already working; dispatched by the runner."""

    @classmethod
    def name(cls) -> str:
        """:returns: ``"message_helper"``."""
        return MESSAGE_HELPER_TOOL_NAME

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Pass a message to a Helper that is already working, such as a correction or an "
            "added detail from the person about that task. The Helper reads it at its next step "
            "and keeps going on the same task; its result still arrives here when it finishes. "
            "Use it instead of starting another Helper. `helper_id` is the id `start_helper` "
            "returned; leave it out when exactly one Helper is running."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "What the Helper should know, in the person's words.",
                        },
                        "helper_id": {
                            "type": "string",
                            "description": "The Helper to tell, from `start_helper`.",
                        },
                    },
                    "required": ["message"],
                    "additionalProperties": False,
                },
            },
        }
