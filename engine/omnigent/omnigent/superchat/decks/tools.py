"""Built-in tool for decks: ``deck_export``.

Schema-only class: the runner dispatches it to :mod:`omnigent.superchat.decks.handlers`, which
runs in the person's Computer.
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

DECK_TOOL_NAMES = ("deck_export",)
DECK_EXPORT_FORMATS = ("pptx", "pdf")


class DeckExportTool(Tool):
    """Export a saved deck to PowerPoint or PDF; dispatched to the runner handler."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "deck_export"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Export a saved deck (a `.deck.html` file saved with artifact_save) to an editable "
            "PowerPoint (.pptx) or a vector PDF in the person's Computer, and save the result as "
            "a new file in this chat. The person sees the file card automatically."
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
                        "artifact_id": {
                            "type": "string",
                            "description": "The deck's artifact id (from artifact_save/list).",
                        },
                        "format": {
                            "type": "string",
                            "enum": list(DECK_EXPORT_FORMATS),
                            "description": "pptx for editable PowerPoint, pdf for a vector PDF.",
                        },
                    },
                    "required": ["artifact_id", "format"],
                    "additionalProperties": False,
                },
            },
        }
