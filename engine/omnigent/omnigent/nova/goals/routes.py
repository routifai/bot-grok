"""REST routes for Goals (``/v1/nova/goals``).

Every route is owner-only: the caller's identity comes from
``NovaDeps.auth_provider`` (never a body/query field), and every store call is
scoped to that identity — a Goal or Proposal belonging to someone else reads
back as ``404``/``409`` exactly as if it didn't exist, never revealing that it
does. Creating a Goal and changing a Proposal's plan happen through the
``nova_goals`` tool (``tools.py``), not here — these routes are the read
surface plus the two decisions only the person can make (accept/dismiss) and
the settings only they should change (status, check-ins).
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaDeps, actor_from_request
from omnigent.nova.goals import create_store, service
from omnigent.nova.goals.entities import Goal, GoalStatus


class UpdateGoalRequest(BaseModel):
    """Body for ``PATCH /goals/{goal_id}``. ``None`` fields are left unchanged."""

    # "done" is not settable directly — it reflects the plan's own progress,
    # not a person's manual flip, mirroring the TypeScript reference (`goals.ts`).
    status: Literal["active", "paused", "cancelled"] | None = None
    check_in_crons: list[str] | None = None
    timezone: str | None = None


def _goal_response(goal: Goal) -> dict[str, Any]:
    return {"object": "goal", **service.goal_to_dict(goal)}


def _require_actor(request: Request, deps: NovaDeps) -> str:
    """Resolve the caller's user id, or raise 401."""
    actor = actor_from_request(request, deps.auth_provider)
    if actor is None:
        raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
    return actor.user_id


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the Goals router (mounted under ``/v1/nova`` by the registry).

    :param deps: Server-owned dependencies; only ``storage_location`` and
        ``auth_provider`` are used here.
    :returns: A configured :class:`APIRouter`.
    """
    router = APIRouter()
    store = create_store(deps.storage_location)

    @router.get("/goals")
    async def list_goals(request: Request) -> dict[str, Any]:
        """List the caller's Goals."""
        user_id = _require_actor(request, deps)
        goals = await asyncio.to_thread(store.list, user_id=user_id)
        return {"object": "list", "data": [_goal_response(g) for g in goals]}

    @router.get("/goals/{goal_id}")
    async def get_goal(request: Request, goal_id: str) -> dict[str, Any]:
        """Return one of the caller's Goals."""
        user_id = _require_actor(request, deps)
        goal = await asyncio.to_thread(store.get, goal_id, user_id=user_id)
        if goal is None:
            raise OmnigentError("Goal not found", code=ErrorCode.NOT_FOUND)
        return _goal_response(goal)

    @router.patch("/goals/{goal_id}")
    async def update_goal(
        request: Request, goal_id: str, body: UpdateGoalRequest
    ) -> dict[str, Any]:
        """Update a Goal's status and/or check-in schedule."""
        user_id = _require_actor(request, deps)
        status = GoalStatus(body.status) if body.status is not None else None
        goal = await asyncio.to_thread(
            service.set_status,
            store,
            user_id=user_id,
            goal_id=goal_id,
            status=status,
            check_in_crons=body.check_in_crons,
            timezone=body.timezone,
        )
        return _goal_response(goal)

    @router.post("/goals/proposals/{proposal_id}/accept")
    async def accept_proposal(request: Request, proposal_id: str) -> dict[str, Any]:
        """Accept an open Proposal, replacing the Goal's plan with its Tasks."""
        user_id = _require_actor(request, deps)
        goal = await asyncio.to_thread(
            service.accept_proposal, store, user_id=user_id, proposal_id=proposal_id
        )
        return _goal_response(goal)

    @router.post("/goals/proposals/{proposal_id}/dismiss")
    async def dismiss_proposal(request: Request, proposal_id: str) -> dict[str, Any]:
        """Dismiss an open Proposal, leaving the Goal's current plan untouched."""
        user_id = _require_actor(request, deps)
        goal = await asyncio.to_thread(
            service.dismiss_proposal, store, user_id=user_id, proposal_id=proposal_id
        )
        return _goal_response(goal)

    return router
