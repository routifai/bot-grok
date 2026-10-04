"""Built-in tools for objectives (outcomes pursued over time).

Schema-only classes: the runner dispatches each to the server's
``/v1/objectives`` REST endpoints (see ``_execute_objective_tool``).

* ``objective_create`` — hand over an outcome with a first plan and a cadence.
* ``objective_get`` / ``objective_list`` — read objectives and their plans.
* ``objective_update_task`` — mark a task's progress.
* ``objective_propose`` — suggest a revised plan; the person accepts it.
"""

from __future__ import annotations

from typing import Any

from omnigent.tools.base import Tool

OBJECTIVE_TOOL_NAMES = (
    "objective_create",
    "objective_get",
    "objective_list",
    "objective_update_task",
    "objective_propose",
)
# The subset a Helper (sub-agent session) may call, for its own objective.
OBJECTIVE_HELPER_TOOL_NAMES = ("objective_get", "objective_update_task", "objective_propose")

_PLAN_DESC = (
    "Ordered list of tasks. Each item is a task title string, or an object "
    "{id?, title}; give an existing task's id to keep it."
)
_PLAN_SCHEMA: dict[str, Any] = {
    "type": "array",
    "description": _PLAN_DESC,
    "items": {
        "anyOf": [
            {"type": "string"},
            {
                "type": "object",
                "properties": {"id": {"type": "string"}, "title": {"type": "string"}},
                "required": ["title"],
                "additionalProperties": False,
            },
        ]
    },
}


class _ObjectiveTool(Tool):
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


class ObjectiveCreateTool(_ObjectiveTool):
    """Create an objective; dispatched to ``POST /v1/objectives``."""

    _NAME = "objective_create"
    _DESC = (
        "Hand over an outcome to pursue over time: creates the objective, proposes "
        "its first plan for the person to accept, and schedules recurring work on "
        "it. Not for quick errands."
    )
    _PROPERTIES = {
        "title": {"type": "string", "description": "Short name of the outcome."},
        "description": {"type": "string", "description": "What done looks like."},
        "plan": _PLAN_SCHEMA,
        "cadence": {
            "type": "string",
            "description": (
                "How often to work on it, as an RFC 5545 rule, e.g. "
                "'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' or "
                "'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0'. "
                "At most once per hour."
            ),
        },
        "due": {"type": "string", "description": "Optional ISO-8601 due date."},
    }
    _REQUIRED = ("title", "plan", "cadence")


class ObjectiveGetTool(_ObjectiveTool):
    """Read one objective; dispatched to ``GET /v1/objectives/{id}``."""

    _NAME = "objective_get"
    _DESC = "Read an objective: its status, plan with task progress, and any open proposal."
    _PROPERTIES = {"objective_id": {"type": "string", "description": "The objective id."}}
    _REQUIRED = ("objective_id",)


class ObjectiveListTool(_ObjectiveTool):
    """List this chat's objectives; dispatched to ``GET /v1/objectives``."""

    _NAME = "objective_list"
    _DESC = "List this conversation's objectives with their plans and progress."
    _PROPERTIES: dict[str, Any] = {}


class ObjectiveUpdateTaskTool(_ObjectiveTool):
    """Mark task progress; dispatched to ``PATCH /v1/objectives/{id}/tasks/{task_id}``."""

    _NAME = "objective_update_task"
    _DESC = "Record progress on one task of an objective: its status and a short note."
    _PROPERTIES = {
        "objective_id": {"type": "string", "description": "The objective id."},
        "task_id": {"type": "string", "description": "The task id from objective_get."},
        "status": {
            "type": "string",
            "enum": ["pending", "in_progress", "done", "blocked", "skipped"],
        },
        "note": {"type": "string", "description": "One short sentence on what happened."},
    }
    _REQUIRED = ("objective_id", "task_id", "status")


class ObjectiveProposeTool(_ObjectiveTool):
    """Propose a plan; dispatched to ``POST /v1/objectives/{id}/proposals``."""

    _NAME = "objective_propose"
    _DESC = (
        "Suggest a revised plan (the full ordered list) with the reason. It replaces "
        "any open proposal and only takes effect when the person accepts it."
    )
    _PROPERTIES = {
        "objective_id": {"type": "string", "description": "The objective id."},
        "reason": {"type": "string", "description": "Why the plan should change."},
        "plan": _PLAN_SCHEMA,
    }
    _REQUIRED = ("objective_id", "reason", "plan")
