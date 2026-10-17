"""Tasks (ADR 0025): one engine-kept record per deliverable in progress in a Conversation.

Layout: ``record`` (the task, its line, the card answer; pure), ``store`` (the ``tasks`` table),
``service`` (server side: applies the engine's events), ``routes`` (``/v1/sessions/{id}/tasks``),
``runtime`` (runner side: the turn's lines, tool events, the stall log). No tools: the model
never writes a task.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.tasks.runtime import message_prefix, on_result

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

    if deps.scheduled_task_store is None:
        return
    service = TaskService(
        SqlAlchemyTaskStore(deps.scheduled_task_store.storage_location), deps.conversation_store
    )

    def _card_answer(session_id: str, item_id: str, context: dict[str, Any]) -> None:
        service.card_answered(session_id, item_id, context)

    ON_MESSAGE_CONTEXT["tasks"] = _card_answer
    ON_SESSION_DELETED["tasks"] = service.conversation_deleted
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
    install=_install,
)
