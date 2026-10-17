"""``/v1/sessions/{id}/tasks``: the runner reads a Conversation's tasks and reports what happened.

``GET`` is what a turn and ``deck_new`` read (:meth:`TaskService.view`). ``POST .../events``
carries one event the runner saw: a tool's result (``deck_new``, ``artifact_save``,
``start_helper``) or the end of a Conversation turn (``turn_end``); the server decides what it
does to the record.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_EDIT, LEVEL_READ
from omnigent.server.routes._auth_helpers import get_user_id, require_access
from omnigent.server.routes._errors import session_not_found
from omnigent.superchat.tasks.service import TaskService

#: ``event`` name -> the service method that applies it.
EVENTS = {
    "deck_new": TaskService.deck_built,
    "artifact_save": TaskService.saved,
    "start_helper": TaskService.helper_started,
    "turn_end": TaskService.turn_ended,
}


def create_tasks_router(
    service: TaskService, *, permission_store: Any = None, auth_provider: Any = None
) -> APIRouter:
    """Build the tasks router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    async def _check(request: Request, session_id: str, level: int) -> None:
        if permission_store is not None:
            await require_access(
                get_user_id(request, auth_provider),
                session_id,
                level,
                permission_store,
                service.conversations,
            )

    @router.get("/sessions/{session_id}/tasks")
    async def read_tasks(request: Request, session_id: str) -> dict[str, Any]:
        """The Conversation's active tasks, the person's latest message and a card answer."""
        await _check(request, session_id, LEVEL_READ)
        view = await asyncio.to_thread(service.view, session_id)
        if view is None:
            raise session_not_found()
        return view

    @router.post("/sessions/{session_id}/tasks/events")
    async def task_event(request: Request, session_id: str) -> dict[str, Any]:
        """Apply one event the runner saw; answers with the task it changed (or ``None``)."""
        await _check(request, session_id, LEVEL_EDIT)
        body = await request.json()
        apply = EVENTS.get(body.get("event")) if isinstance(body, dict) else None
        if apply is None:
            raise OmnigentError(
                f"event must be one of {', '.join(EVENTS)}", code=ErrorCode.INVALID_INPUT
            )
        task = await asyncio.to_thread(apply, service, session_id, body)
        return {"task": task.to_wire() if task is not None else None}

    return router
