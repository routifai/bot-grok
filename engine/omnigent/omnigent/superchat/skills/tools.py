"""Built-in tools for taught skills (tasks the person demonstrated on the Computer).

Schema-only classes: the runner dispatches each to the server's ``/v1/taught-skills`` REST
endpoints (see ``_execute_skill_tool``).

* ``skill_list`` — the person's saved skills and their inputs.
* ``skill_run`` — load a saved skill's steps with the run's inputs filled in; then follow them.
* ``skill_draft_save`` — the teacher Helper writes the draft of a just-recorded skill.
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

SKILL_TOOL_NAMES = ("skill_list", "skill_run", "skill_draft_save")
# The only skill tool a Helper (sub-agent session) may call.
SKILL_HELPER_TOOL_NAMES = ("skill_draft_save",)

_STEP_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "description": "What to achieve, not which pixel to click."},
        "check": {"type": "string", "description": "How to tell the step worked."},
        "approval": {
            "type": "boolean",
            "description": "True when the step sends, buys, publishes or deletes something.",
        },
        "keyframe": {"type": "string", "description": "The frame (k#) that shows this step."},
        "hint": {
            "type": "object",
            "properties": {
                "role": {"type": "string"},
                "name": {"type": "string"},
                "selector": {"type": "string"},
                "url": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "required": ["intent", "check"],
    "additionalProperties": False,
}
_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "lower_snake_case identifier."},
        "label": {"type": "string"},
        "default": {"type": "string", "description": "The value used in the demonstration."},
        "description": {"type": "string"},
    },
    "required": ["name", "default"],
    "additionalProperties": False,
}


class _SkillTool(Tool):
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


class SkillListTool(_SkillTool):
    """List saved skills; dispatched to ``GET /v1/taught-skills``."""

    _NAME = "skill_list"
    _DESC = "List the skills the person taught you, with their inputs."


class SkillRunTool(_SkillTool):
    """Load a skill for a run; dispatched to ``POST /v1/taught-skills/{id}/render``."""

    _NAME = "skill_run"
    _DESC = (
        "Load a saved skill with this run's inputs filled in, then do what it says in the "
        "Computer's browser. Inputs not given fall back to the demonstration's value; if the "
        "result lists missing inputs, ask the person for them first."
    )
    _PROPERTIES = {
        "skill": {"type": "string", "description": "The skill's id or exact name."},
        "inputs": {
            "type": "object",
            "description": "Input values by input name.",
            "additionalProperties": {"type": "string"},
        },
    }
    _REQUIRED = ("skill",)


class SkillDraftSaveTool(_SkillTool):
    """Save a skill draft; dispatched to ``PUT /v1/taught-skills/{id}/doc``."""

    _NAME = "skill_draft_save"
    _DESC = "Save the draft skill written from a recording. Call once with the whole draft."
    _PROPERTIES = {
        "skill_id": {"type": "string", "description": "The skill id from the Brief."},
        "name": {"type": "string", "description": "Short name, at most 6 words."},
        "goal": {"type": "string", "description": "One sentence: what the skill achieves."},
        "preconditions": {"type": "array", "items": {"type": "string"}},
        "inputs": {"type": "array", "items": _INPUT_SCHEMA},
        "steps": {"type": "array", "items": _STEP_SCHEMA},
        "returns": {"type": "string", "description": "What to report back when done."},
    }
    _REQUIRED = ("skill_id", "name", "goal", "steps")
