"""Built-in tool for decks: ``deck_export``.

Schema-only class: the runner dispatches it to :mod:`omnigent.superchat.decks.handlers`, which
runs in the person's Computer.
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

DECK_TOOL_NAMES = ("deck_export", "deck_new", "deck_check", "deck_themes", "deck_theme_set")
DECK_AUTHORING_TOOL_NAMES = ("deck_new", "deck_check", "deck_themes", "deck_theme_set")
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
            "Export a saved deck (a `.deck.html` file you saved with artifact_save) to an "
            "editable PowerPoint (.pptx) or a vector PDF in the person's Computer, and save the "
            "result as a new file in this chat. The person sees the file card automatically. "
            "Use it when they ask for PowerPoint or PDF; the deck viewer also has Export buttons."
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


class DeckNewTool(Tool):
    """Create a deck file from a template and the model's slides; dispatched to the runner."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "deck_new"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        from omnigent.superchat.decks import kit

        names = ", ".join(kit.templates())
        return (
            "Create a slide deck file. You write only the slides (HTML sections); this assembles "
            "the fixed 1920x1080 deck framework, the template's theme and embedded fonts around "
            "them, writes the `.deck.html` file, and checks the layout in the Computer. "
            f"Templates (themes; call deck_themes for what each is for): {names}. "
            "Returns problems to fix, then save the file with artifact_save."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        from omnigent.superchat.decks import kit

        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": (
                                "Where to write it, ending in .deck.html, "
                                "e.g. your_files/q3-review.deck.html."
                            ),
                        },
                        "template": {"type": "string", "enum": list(kit.templates())},
                        "title": {"type": "string", "description": "The deck's title."},
                        "slides": {
                            "type": "string",
                            "description": (
                                "Omit to get the layout menu. The slides: one "
                                '<section class="slide ..." data-screen-label="NN Name" '
                                'data-nova-id="..."> per slide, using the layouts in the deck '
                                'rules. The first has class "slide active".'
                            ),
                        },
                    },
                    "required": ["path", "template", "title"],
                    "additionalProperties": False,
                },
            },
        }


class DeckCheckTool(Tool):
    """Check a deck file's layout in the Computer; dispatched to the runner."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "deck_check"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Check a deck file after you edit it: content past the slide or in the footer band, "
            "clipped text, missing ids, headlines that are too long. Run it before saving a deck "
            "and fix every error it lists."
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
                        "path": {
                            "type": "string",
                            "description": "The .deck.html file in your workspace.",
                        }
                    },
                    "required": ["path"],
                    "additionalProperties": False,
                },
            },
        }


class DeckThemesTool(Tool):
    """List the deck theme dictionary; dispatched to the runner (no file access needed)."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "deck_themes"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "List the deck themes you can choose from: id, name, mood, category "
            "(professional, editorial, bold, dark), light or dark mode, and what it is best for. "
            "Call it before deck_new and pick the theme that fits the request instead of "
            "relying on remembered ids."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        }


class DeckThemeSetTool(Tool):
    """Restyle a deck file with another theme, slides untouched; dispatched to the runner."""

    @classmethod
    def name(cls) -> str:
        """:returns: The tool name."""
        return "deck_theme_set"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Switch a deck file to another theme: swaps its colours, type, theme CSS and embedded "
            "fonts and leaves every slide's content alone, then re-checks the layout. Use it "
            "when the person asks for a different look; the deck keeps its file, so save it "
            "again with artifact_save. Custom CSS and token overrides the deck has outside the "
            "theme markers (written after the closing marker) are kept. If something was edited "
            "between the markers the call fails and says so, and the file is not changed. "
            "Do not use it unless they asked for a new theme."
        )

    def get_schema(self) -> dict[str, Any]:
        """:returns: The OpenAI-format tool schema."""
        from omnigent.superchat.decks import kit

        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "The .deck.html file in your workspace.",
                        },
                        "theme_id": {"type": "string", "enum": list(kit.templates())},
                    },
                    "required": ["path", "theme_id"],
                    "additionalProperties": False,
                },
            },
        }
