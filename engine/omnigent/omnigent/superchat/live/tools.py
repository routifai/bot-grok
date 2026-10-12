"""Live artifact tools (schema only; the runner calls the engine's routes).

Super Chat: ``artifact_keep_updated`` / ``artifact_stop_updating``. Helper (the scheduled run):
``live_update_context`` / ``live_update_save``.
"""

from __future__ import annotations

from omnigent.superchat.artifacts.tools import ArtifactTool

KEEP_TOOL_NAME = "artifact_keep_updated"
STOP_TOOL_NAME = "artifact_stop_updating"
CONTEXT_TOOL_NAME = "live_update_context"
SAVE_TOOL_NAME = "live_update_save"
SUPER_CHAT_TOOL_NAMES = (KEEP_TOOL_NAME, STOP_TOOL_NAME)
HELPER_TOOL_NAMES = (CONTEXT_TOOL_NAME, SAVE_TOOL_NAME)

_PAGE = {"type": "string", "description": "The page's file name in this chat, e.g. 'prices.html'."}
_SOURCES = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Web page URLs or Computer file paths the page's facts come from.",
}


class KeepUpdatedTool(ArtifactTool):
    _NAME = KEEP_TOOL_NAME
    _DESC = (
        "Keep a saved HTML page up to date: on the schedule, a Helper re-reads the page's "
        "sources and changes only the parts that show source facts. Calling it again for the "
        "same page changes the schedule. Without sources, the first run infers them."
    )
    _PROPERTIES = {
        "name": _PAGE,
        "rrule": {
            "type": "string",
            "description": (
                "RFC 5545 rule in the person's timezone, at most hourly, e.g. "
                "'FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0' (Mondays 08:00)."
            ),
        },
        "sources": _SOURCES,
        "tell": {
            "type": "string",
            "enum": ["notable", "every", "never"],
            "description": "When a run is worth telling the person. Default: notable.",
        },
        "on_change": {
            "type": "boolean",
            "description": (
                "Also update a couple of minutes after a source file changes in the Computer. "
                "Default: true."
            ),
        },
    }
    _REQUIRED = ("name", "rrule")


class StopUpdatingTool(ArtifactTool):
    _NAME = STOP_TOOL_NAME
    _DESC = "Stop keeping a page updated. The page and its versions stay as they are."
    _PROPERTIES = {"name": _PAGE}
    _REQUIRED = ("name",)


class UpdateContextTool(ArtifactTool):
    _NAME = CONTEXT_TOOL_NAME
    _DESC = (
        "Start of a live page update: returns the page's sources, the facts read last time, "
        "the newest version number and the page's HTML source."
    )
    _PROPERTIES = {"name": _PAGE}
    _REQUIRED = ("name",)


class UpdateSaveTool(ArtifactTool):
    _NAME = SAVE_TOOL_NAME
    _DESC = (
        "Finish a live page update. `changes` holds only facts that differ from what the page "
        "shows, by the data-superchat-id of the element holding each; leave it empty when "
        "nothing differs. Parts the person edited come back as `suggestions` instead of being "
        "overwritten; `declined` lists values the person undid before, left as they are on "
        "purpose. "
        "The answer's `tell`: 'never' means nothing worth telling in your Result; "
        "'notable' means only notable changes, suggestions and unplaced changes; 'every' means "
        "one line about what changed."
    )
    _PROPERTIES = {
        "name": _PAGE,
        "base_version": {
            "type": "integer",
            "description": "The version live_update_context returned.",
        },
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The element's data-superchat-id."},
                    "after": {"type": "string", "description": "The new text."},
                    "source": {"type": "string", "description": "The source it came from."},
                    "notable": {"type": "boolean", "description": "Worth telling the person."},
                },
                "required": ["id", "after"],
            },
        },
        "facts": {
            "type": "object",
            "description": "What you read, per source: {source: {hash, values}}.",
        },
        "sources": {
            **_SOURCES,
            "description": "Only when the page had none: the ones you inferred.",
        },
    }
    _REQUIRED = ("name", "base_version", "changes", "facts")
