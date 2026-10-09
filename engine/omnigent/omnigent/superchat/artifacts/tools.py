"""Built-in tools for artifacts (deliverable files the person can open in the app).

Schema-only classes: the runner dispatches each to the server's ``/v1/artifacts`` REST
endpoints (``artifact_save`` first reads the file from the Computer workspace).

* ``artifact_save`` — save a finished file from the workspace into the Conversation.
* ``artifact_list`` — list the Conversation's saved files.
* ``artifact_delete`` — delete a saved file (the person is asked first).
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

ARTIFACT_TOOL_NAMES = ("artifact_save", "artifact_list", "artifact_delete")


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
        "file card automatically; do not render one yourself."
    )
    _PROPERTIES = {
        "path": {
            "type": "string",
            "description": "Path of the file in your workspace, e.g. 'report.html'.",
        },
        "title": {"type": "string", "description": "Optional short display title."},
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
