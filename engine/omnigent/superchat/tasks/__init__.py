"""Tasks (ADR 0025): one engine-kept record per deliverable in progress in a Conversation.

Layout: ``record`` (the task, its line, the card answer, the one stall rule, the plan's evidence
rule of ADR 0027; pure), ``store``
(the ``tasks`` and ``card_answers`` tables),
``service`` (server side: applies the engine's events), ``routes`` (``/v1/sessions/{id}/tasks``),
``runtime`` (runner side: the turn's lines, tool and turn-end events, the stall log). No tools:
the model never writes a task. Conversation-only: a Helper's turn reads no task lines.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.tasks.runtime import message_prefix, on_result, tool_denied, turn_ended

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.server.routes._sessions.orchestration import (
        ON_MESSAGE_CONTEXT,
        ON_SESSION_DELETED,
    )
    from omnigent.superchat.tasks.routes import create_tasks_router
    from omnigent.superchat.tasks.service import TaskService
    from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

    if deps.storage_location is None:
        return
    service = TaskService(SqlAlchemyTaskStore(deps.storage_location), deps.conversation_store)
    ON_MESSAGE_CONTEXT["tasks"] = service.message_context
    ON_SESSION_DELETED["tasks"] = service.conversation_deleted
    # The transcript and the activity project plans through the one service (``plan_views``).
    app.state.task_service = service
    app.include_router(
        create_tasks_router(
            service, permission_store=deps.permission_store, auth_provider=deps.auth_provider
        ),
        prefix="/v1",
        tags=["tasks"],
    )


FEATURE = Feature(
    name="tasks",
    tools=_tools,
    on_result=on_result,
    message_prefix=message_prefix,
    conversation_only=True,
    on_turn_end=turn_ended,
    on_tool_denied=tool_denied,
    install=_install,
)
