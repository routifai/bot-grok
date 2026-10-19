"""``/v1/sessions/{id}/tasks``: what a turn and ``deck_new`` read, and the plan events.

``GET`` is what a turn and ``deck_new`` read (:meth:`TaskService.view`); it changes nothing.
``POST .../events`` carries a ``plan`` card shown or a result that is evidence for a plan item
(``evidence``: a brief, a read, a check), applied to the plan a task already keeps.
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
    "plan": TaskService.plan_rendered,
    "evidence": TaskService.evidence,
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
        """The person's latest message, the session's Round, its card answer and the Rounds
        still working."""
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
        result = await asyncio.to_thread(apply, service, session_id, body)
        return {"task": result.to_wire() if result is not None else None}

    return router
