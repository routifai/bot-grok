"""Tools of live artifacts (schema only; the runner calls the engine's routes).

Super Chat: ``artifact_keep_updated`` and ``artifact_stop_updating``. Helper (the scheduled
update run): ``live_update_context``, ``live_update_save`` and ``live_update_checked``.
"""

from __future__ import annotations

from omnigent.superchat.artifacts.tools import ArtifactTool

KEEP_TOOL_NAME = "artifact_keep_updated"
STOP_TOOL_NAME = "artifact_stop_updating"
CONTEXT_TOOL_NAME = "live_update_context"
SAVE_TOOL_NAME = "live_update_save"
CHECKED_TOOL_NAME = "live_update_checked"
SUPER_CHAT_TOOL_NAMES = (KEEP_TOOL_NAME, STOP_TOOL_NAME)
HELPER_TOOL_NAMES = (CONTEXT_TOOL_NAME, SAVE_TOOL_NAME, CHECKED_TOOL_NAME)

_PAGE_NAME = {
    "type": "string",
    "description": "The page's file name in this chat, e.g. 'prices.html'.",
}
_FACTS = {
    "type": "object",
    "description": (
        "What you found, per source: {source ref: {hash, values}}. hash is any short digest of "
        "the relevant part of the source; values are the figures or lines you read."
    ),
}
_SOURCES = {
    "type": "array",
    "items": {"type": "string"},
    "description": "Web page URLs or Computer file paths the page's facts come from.",
}


class KeepUpdatedTool(ArtifactTool):
    """Make a saved page update itself on a schedule."""

    _NAME = KEEP_TOOL_NAME
    _DESC = (
        "Keep a saved HTML page up to date: on the schedule, a Helper re-reads the page's "
        "sources and changes only the parts that show source facts. Use it when the person "
        "asks to keep a page updated, e.g. 'every Monday morning'. Calling it again for the "
        "same page changes the schedule. Sources are optional: when omitted, the first run "
        "infers them from the page and this chat."
    )
    _PROPERTIES = {
        "name": _PAGE_NAME,
        "frequency": {"type": "string", "enum": ["daily", "weekly", "monthly"]},
        "time": {"type": "string", "description": "Local time of day, HH:MM (24 hours)."},
        "weekday": {
            "type": "string",
            "description": "For weekly: monday ... sunday.",
        },
        "month_day": {"type": "integer", "description": "For monthly: day of the month, 1-28."},
        "sources": _SOURCES,
        "tell": {
            "type": "string",
            "enum": ["notable", "every", "never"],
            "description": "When a run is worth telling the person. Default: notable.",
        },
    }
    _REQUIRED = ("name", "frequency", "time")


class StopUpdatingTool(ArtifactTool):
    """Stop a page from updating itself."""

    _NAME = STOP_TOOL_NAME
    _DESC = "Stop keeping a page updated. The page and its versions stay as they are."
    _PROPERTIES = {"name": _PAGE_NAME}
    _REQUIRED = ("name",)


class UpdateContextTool(ArtifactTool):
    """First call of a scheduled page update."""

    _NAME = CONTEXT_TOOL_NAME
    _DESC = (
        "Start of a live page update: returns the page's sources, the facts seen last time, "
        "the values the person rejected, what the last update wrote, the newest version "
        "number and the page's HTML source. If `defer` is true the person is editing the page "
        "right now: stop immediately, do nothing else and end with a one-line Result saying "
        "you skipped."
    )
    _PROPERTIES = {"name": _PAGE_NAME}
    _REQUIRED = ("name",)


class UpdateSaveTool(ArtifactTool):
    """Apply the changes a scheduled page update found."""

    _NAME = SAVE_TOOL_NAME
    _DESC = (
        "Apply the real changes you found to the page as one new version. Send only facts that "
        "differ from what the page shows now, by the data-superchat-id of the element holding "
        "each. `base_version` is the version live_update_context returned; if it says the page "
        "changed, call live_update_context again. Parts the person edited since the last "
        "update are not overwritten: they come back as `suggestions`. The answer carries "
        "`tell`: 'never' means say nothing worth telling in your Result; 'notable' means "
        "mention only changes flagged notable, suggestions and unplaced changes; 'every' means "
        "one line about what changed."
    )
    _PROPERTIES = {
        "name": _PAGE_NAME,
        "base_version": {"type": "integer"},
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The element's data-superchat-id."},
                    "after": {"type": "string", "description": "The new text."},
                    "source": {"type": "string", "description": "The source ref it came from."},
                    "notable": {
                        "type": "boolean",
                        "description": "True when the person would want to hear about it.",
                    },
                },
                "required": ["id", "after"],
            },
        },
        "facts": _FACTS,
        "sources": {
            **_SOURCES,
            "description": "Only when the page had none: the sources you inferred.",
        },
    }
    _REQUIRED = ("name", "base_version", "changes", "facts")


class UpdateCheckedTool(ArtifactTool):
    """Record that a scheduled page update found nothing new."""

    _NAME = CHECKED_TOOL_NAME
    _DESC = (
        "Record that the sources were read and nothing on the page needs to change. No version "
        "is made and the person is not told anything."
    )
    _PROPERTIES = {"name": _PAGE_NAME, "facts": _FACTS}
    _REQUIRED = ("name", "facts")
