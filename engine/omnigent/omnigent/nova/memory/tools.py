"""Built-in tool: ``nova_remember`` — save a durable fact to the person's memory."""

from __future__ import annotations

import json
from typing import Any

from omnigent.nova import memory as _memory
from omnigent.nova._shared import private_actor
from omnigent.nova.memory.entities import NoteKind
from omnigent.nova.memory.service import DEFAULT_PATH, remember
from omnigent.tools.base import Tool, ToolContext


class NovaRememberTool(Tool):
    """Append a durable fact to the session owner's Nova memory.

    Available only from the person's own private session (``_shared.Scope``):
    a shared/project session has no single owner whose memory it would be
    safe to write to, so the tool refuses rather than guessing.
    """

    @classmethod
    def name(cls) -> str:
        """:returns: ``"nova_remember"``."""
        return "nova_remember"

    @classmethod
    def description(cls) -> str:
        """:returns: Human-readable description of the tool."""
        return (
            "Save a durable fact to memory: something worth recalling in every "
            "future conversation with this person — a preference, a decision, "
            "recurring context. Appends to the existing note rather than "
            "replacing it. Only available in the person's own private session."
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
                        "content": {
                            "type": "string",
                            "description": "The fact to remember, as one line or paragraph.",
                        },
                        "kind": {
                            "type": "string",
                            "enum": [k.value for k in NoteKind],
                            "description": (
                                "'about_you' for a fact about the person (the default); "
                                "'nova' for the assistant's own notes to itself."
                            ),
                        },
                        "path": {
                            "type": "string",
                            "description": f"Note path. Defaults to {DEFAULT_PATH!r}.",
                        },
                    },
                    "required": ["content"],
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        """
        Append *content* to the resolved owner's note.

        :param arguments: JSON with ``"content"`` and optional ``"kind"`` /
            ``"path"`` keys.
        :param ctx: Execution context; ``conversation_id`` identifies the
            session whose owner's memory is written.
        :returns: JSON ``{"ok": true, "id": ..., "revision": ...}``, or
            ``{"error": ...}`` — including when the session's scope refuses
            the write.
        """
        # Imported here, not at module level: omnigent.tools.builtins.__init__
        # imports omnigent.nova.memory.tools to register this very tool (see
        # _registry.tools()), so a top-level import back into
        # omnigent.tools.builtins would be circular whenever this module is
        # the first of the two to load.
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        content = args.get("content")
        if not isinstance(content, str) or not content.strip():
            return json.dumps({"error": "missing required 'content' argument"})

        kind_arg = args.get("kind", NoteKind.ABOUT_YOU.value)
        try:
            kind = NoteKind(kind_arg)
        except ValueError:
            return json.dumps({"error": f"invalid 'kind': {kind_arg!r}"})

        path = args.get("path", DEFAULT_PATH)
        if not isinstance(path, str) or not path.strip():
            return json.dumps({"error": "'path' must be a non-empty string"})

        actor, refusal = private_actor(ctx.conversation_id)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        note = remember(actor, content, kind, path, store=_memory._runtime_store())
        return json.dumps({"ok": True, "id": note.id, "revision": note.revision})


def _create_nova_remember(config: dict[str, str]) -> Tool:
    """
    Factory for :class:`NovaRememberTool`.

    :param config: Tool config (unused; the tool needs no configuration).
    :returns: A :class:`NovaRememberTool` instance.
    """
    del config
    return NovaRememberTool()


TOOLS = {"nova_remember": _create_nova_remember}
