"""Built-in tools for artifacts (deliverable files the person can open in the app).

Schema-only classes: the runner dispatches each to the server's ``/v1/artifacts`` REST
endpoints (``artifact_save`` first reads the file from the host workspace).

* ``artifact_save`` — save a finished file from the workspace into the Conversation.
* ``artifact_list`` — list the Conversation's saved files.
* ``artifact_delete`` — delete a saved file (the person is asked first).
* ``artifact_patch`` — change named elements of a file in place (a file's studio only, ADR 0024).
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

ARTIFACT_TOOL_NAMES = ("artifact_save", "artifact_list", "artifact_delete", "artifact_patch")


class ArtifactTool(Tool):
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


class ArtifactSaveTool(ArtifactTool):
    """Save a workspace file for the person; dispatched to ``POST /v1/artifacts``."""

    _NAME = "artifact_save"
    _DESC = (
        "Save a finished file from your workspace (html, md, pdf, docx, xlsx, csv, pptx, png, "
        "jpg, txt, json; 25 MB max) so the person can open, preview and download it in the "
        "app. The same file name in the same chat becomes a new version. The person sees the "
        "file card automatically; do not render one yourself. In an HTML page or app, give "
        "each section and each element the person may want to change by hand (headings, "
        "buttons, labels, key text) a unique data-superchat-id (lower-case words joined by "
        'hyphens, e.g. data-superchat-id="add-button") so they can edit it in place.'
    )
    _PROPERTIES = {
        "path": {
            "type": "string",
            "description": "Path of the file in your workspace, e.g. 'report.html'.",
        },
        "title": {"type": "string", "description": "Optional short display title."},
        "base_version": {
            "type": "integer",
            "minimum": 1,
            "description": (
                "The version of the file you edited. Required in a file's own chat (its "
                "studio); a save whose base is no longer the newest is refused as stale."
            ),
        },
    }
    _REQUIRED = ("path",)


class ArtifactListTool(ArtifactTool):
    """List this chat's saved files; dispatched to ``GET /v1/artifacts``."""

    _NAME = "artifact_list"
    _DESC = "List the files already saved for the person in this chat (name, kind, versions)."


class ArtifactDeleteTool(ArtifactTool):
    """Delete a saved file; dispatched to ``DELETE /v1/artifacts/{id}``."""

    _NAME = "artifact_delete"
    _DESC = (
        "Delete a saved file and all its versions. The person is asked to approve first; "
        "only call it when they asked you to remove the file."
    )
    _PROPERTIES = {"artifact_id": {"type": "string", "description": "The artifact id."}}
    _REQUIRED = ("artifact_id",)


class ArtifactPatchTool(ArtifactTool):
    """Patch a file by element id; dispatched to ``POST /v1/artifacts/{id}/patch``.

    Offered in a file's studio only (ADR 0024): the same deterministic operations as the
    person's hand edits (``artifacts/patches.py``), saved as the file's next version.
    """

    _NAME = "artifact_patch"
    _DESC = (
        "Change this chat's file in place by element id (data-superchat-id) and save the result "
        "as its next version; the workspace file is updated to match. Prefer it to rewriting "
        "the file. Patch kinds: set-text {id, text}; set-style {id, style: {property: value or "
        "null}}; set-attributes {id, attributes: {href|alt: value or null}}; remove-element "
        "{id}; duplicate-element {id}; set-theme {theme} (a deck only); set-full-source "
        "{source, summary} (a whole Markdown or text document). Refused as stale when "
        "base_version is no longer the newest: read the file again and redo the change."
    )
    _PROPERTIES = {
        "artifact_id": {
            "type": "string",
            "description": "The file's group id from the file line (any version id works).",
        },
        "base_version": {
            "type": "integer",
            "minimum": 1,
            "description": "The version you are changing: the newest one in the file line.",
        },
        "patches": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [
                            "set-text",
                            "set-style",
                            "set-attributes",
                            "remove-element",
                            "duplicate-element",
                            "set-theme",
                            "set-full-source",
                        ],
                    },
                    "id": {"type": "string"},
                    "text": {"type": "string"},
                    "style": {"type": "object"},
                    "attributes": {"type": "object"},
                    "theme": {"type": "string"},
                    "source": {"type": "string"},
                    "summary": {"type": "string"},
                },
                "required": ["kind"],
            },
        },
    }
    _REQUIRED = ("artifact_id", "base_version", "patches")
