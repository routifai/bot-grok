"""The ``nova_goals`` built-in tool: create a Goal, propose a plan, or update
a Task's progress.

Private-scope only (see ``omnigent.nova._shared.Scope``) — a session working on
someone's shared project has no business creating or changing that person's
Goals. Reading/listing Goals and deciding a Proposal (accept/dismiss) are not
tool actions; they are the person's own calls, made through ``routes.py``.

**Owner resolution.** A tool only gets a :class:`~omnigent.tools.base.ToolContext`
(task/agent/workspace/conversation id) — no :class:`NovaActor` is handed in.
This tool resolves the acting person from ``ctx.conversation_id`` via the
global :class:`~omnigent.stores.conversation_store.ConversationStore`
(``omnigent.runtime.get_conversation_store()``, the same accessor
``search_conversations`` uses): the conversation's labels decide its
:class:`Scope` (refusing anything but ``PRIVATE``), and ``get_session_owner``
gives the owning user id. Same shape as ``_resolve_private_actor`` in
``omnigent/nova/memory/tools.py`` — duplicated here rather than imported
(Rule 1: a primitive imports another only through its public package, and
this helper isn't part of either one's public surface) until it moves to
``_shared``.

**Store access.** ``tools.py`` is built at import time, before any
``NovaDeps`` exists (see ``omnigent/nova/_registry.py``), so it cannot take a
``storage_location`` the way ``routes.py`` does. It uses
``omnigent.nova.goals._runtime_store()`` instead — the same lazily-built,
process-wide store ``context.py`` uses, pointed at the same database as
``ConversationStore`` (mirrors ``omnigent.nova.memory``'s ``_runtime_store``).
"""

from __future__ import annotations

import json
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.nova import goals as _goals
from omnigent.nova._shared import NovaActor, Scope, scope_from_labels
from omnigent.nova.goals import service
from omnigent.nova.goals.entities import ProposedTask, TaskStatus
from omnigent.tools.base import Tool, ToolContext

_ACTIONS = ("create", "propose", "update_task")


def _resolve_private_actor(ctx: ToolContext) -> tuple[NovaActor | None, str | None]:
    """Resolve the calling session's owner as a :class:`NovaActor`.

    :param ctx: The tool's execution context.
    :returns: ``(actor, None)`` on success, or ``(None, reason)`` — a reason
        the tool should return as its ``"error"`` — on refusal.
    """
    if ctx.conversation_id is None:
        return None, "no active session for nova_goals"

    from omnigent.db.db_models import current_workspace_id
    from omnigent.runtime import get_conversation_store

    conversation_store = get_conversation_store()
    conversation = conversation_store.get_conversation(ctx.conversation_id)
    if conversation is None:
        return None, "session not found"
    if scope_from_labels(conversation.labels) is not Scope.PRIVATE:
        return None, "nova_goals is only available in a private session"

    owner = conversation_store.get_session_owner(ctx.conversation_id)
    if owner is None:
        return None, "session has no owner"
    return NovaActor(user_id=owner, workspace_id=current_workspace_id()), None


class NovaGoalsTool(Tool):
    """Create a Goal, propose a revised plan, or update a Task's progress."""

    @classmethod
    def name(cls) -> str:
        return "nova_goals"

    @classmethod
    def description(cls) -> str:
        return (
            "Manage the person's Goals: create a new Goal with its first plan, "
            "propose a revised plan for an existing Goal, or update one Task's "
            "progress. Creating and proposing both open a Proposal the person "
            "must accept before it takes effect — this tool never changes a "
            "Goal's plan directly."
        )

    def get_schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name(),
                "description": self.description(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": list(_ACTIONS),
                            "description": "Which operation to perform.",
                        },
                        "title": {
                            "type": "string",
                            "description": "create: the Goal's title.",
                        },
                        "description": {
                            "type": "string",
                            "description": "create: longer detail about the Goal.",
                        },
                        "due": {
                            "type": "string",
                            "description": "create: due date as YYYY-MM-DD.",
                        },
                        "check_in": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "create: cron expressions for scheduled check-ins.",
                        },
                        "goal_id": {
                            "type": "string",
                            "description": "propose/update_task: the Goal to act on.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "propose: why this plan.",
                        },
                        "tasks": {
                            "type": "array",
                            "items": {},
                            "description": (
                                "create: a list of task-title strings for the first plan. "
                                "propose: a list of {title, keep_task_id?} objects for the "
                                "revised plan — set keep_task_id to carry an existing Task's "
                                "status/note over unchanged at its new position."
                            ),
                        },
                        "task_id": {
                            "type": "string",
                            "description": "update_task: the Task to update.",
                        },
                        "status": {
                            "type": "string",
                            "enum": [s.value for s in TaskStatus],
                            "description": "update_task: the Task's new status.",
                        },
                        "note": {
                            "type": "string",
                            "description": (
                                "update_task: note to set on the Task (e.g. why it's "
                                "blocked, or what was done). Omit to leave it unchanged."
                            ),
                        },
                    },
                    "required": ["action"],
                },
            },
        }

    def invoke(self, arguments: str, ctx: ToolContext) -> str:
        # Deferred: omnigent.tools.builtins imports every Nova TOOLS dict
        # (including this module) while its own __init__ is still running,
        # so a module-level import from omnigent.tools.builtins.* here would
        # be a circular import — see omnigent/nova/_registry.py.
        from omnigent.tools.builtins._arguments import parse_json_object_arguments

        args, error = parse_json_object_arguments(arguments)
        if error is not None:
            return json.dumps({"error": error})
        assert args is not None

        action = args.get("action")
        if action not in _ACTIONS:
            return json.dumps({"error": f"action must be one of {', '.join(_ACTIONS)}."})

        actor, refusal = _resolve_private_actor(ctx)
        if refusal is not None:
            return json.dumps({"error": refusal})
        assert actor is not None

        try:
            if action == "create":
                goal = service.create_goal(
                    _goals._runtime_store(),
                    user_id=actor.user_id,
                    title=str(args.get("title", "")),
                    tasks=[t for t in args.get("tasks", []) if isinstance(t, str)],
                    description=str(args.get("description", "")),
                    due_date=args.get("due"),
                    check_in_crons=[c for c in args.get("check_in", []) if isinstance(c, str)],
                )
                return json.dumps({"goal": service.goal_to_dict(goal)})

            if action == "propose":
                goal_id = args.get("goal_id")
                if not isinstance(goal_id, str) or not goal_id:
                    return json.dumps({"error": "goal_id is required."})
                proposed = [
                    ProposedTask(title=str(t.get("title", "")), keep_task_id=t.get("keep_task_id"))
                    for t in args.get("tasks", [])
                    if isinstance(t, dict)
                ]
                goal = service.propose_plan(
                    _goals._runtime_store(),
                    user_id=actor.user_id,
                    goal_id=goal_id,
                    reason=str(args.get("reason", "")),
                    tasks=proposed,
                )
                return json.dumps({"goal": service.goal_to_dict(goal)})

            # action == "update_task"
            goal_id = args.get("goal_id")
            task_id = args.get("task_id")
            if not isinstance(goal_id, str) or not goal_id:
                return json.dumps({"error": "goal_id and task_id are required."})
            if not isinstance(task_id, str) or not task_id:
                return json.dumps({"error": "goal_id and task_id are required."})
            try:
                status = TaskStatus(args.get("status"))
            except ValueError:
                return json.dumps(
                    {"error": f"status must be one of {', '.join(s.value for s in TaskStatus)}."}
                )
            note = args.get("note")
            goal, became_blocked = service.update_task(
                _goals._runtime_store(),
                user_id=actor.user_id,
                goal_id=goal_id,
                task_id=task_id,
                status=status,
                note=note if isinstance(note, str) else None,
            )
            payload = {"goal": service.goal_to_dict(goal), "became_blocked": became_blocked}
            return json.dumps(payload)
        except OmnigentError as exc:
            return json.dumps({"error": exc.message})


def _create_nova_goals(config: dict[str, str]) -> Tool:
    """Factory for the ``TOOLS`` registry. ``config`` is unused — this tool
    takes no per-agent configuration.
    """
    del config
    return NovaGoalsTool()


TOOLS: dict[str, Any] = {"nova_goals": _create_nova_goals}
