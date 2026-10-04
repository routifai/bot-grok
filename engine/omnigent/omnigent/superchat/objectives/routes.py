"""REST for objectives (``/v1/objectives``).

An objective is an outcome pursued over time under a parent session (the
Conversation). Its plan changes shape only through proposals that the owner
accepts or dismisses; task progress is updated in place. When created with a
cadence, a parent-bound scheduled task of Type ``goal`` advances it.

Ownership mirrors scheduled tasks: scoped to the calling user (``"local"`` when
auth is disabled); someone else's objective is a 404.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.entities import Objective, ObjectiveProposal
from omnigent.entities.objective import OBJECTIVE_STATUSES, OBJECTIVE_TASK_STATUSES
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.routes.scheduled_tasks import (
    _validate_rrule_or_400,
    _validate_timezone_or_400,
)
from omnigent.stores import AgentStore, ConversationStore, PermissionStore
from omnigent.stores.objective_store import _UNSET, ObjectiveStore, ProposalNotOpenError
from omnigent.stores.scheduled_task_store import ScheduledTaskStore

GOAL_AGENT_TYPE = "goal"
_MAX_PLAN_ITEMS = 50
_LOG_LIMIT_MAX = 200
_RESULT_PREVIEW_CHARS = 4000


class PlanItem(BaseModel):
    """One proposed plan item; ``id`` keeps an existing task."""

    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, min_length=1)
    title: str = Field(min_length=1, max_length=512)


class CreateObjectiveRequest(BaseModel):
    """Body for ``POST /v1/objectives``."""

    model_config = ConfigDict(extra="forbid")

    parent_session_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=256)
    description: str = ""
    due: str | None = None
    # First plan: becomes the open proposal (the owner accepts it).
    plan: list[PlanItem] = Field(default_factory=list, max_length=_MAX_PLAN_ITEMS)
    reason: str = "First plan"
    # RRULE cadence; omit for an objective that is not advanced on a schedule.
    rrule: str | None = None
    timezone: str | None = None


class UpdateObjectiveRequest(BaseModel):
    """Body for ``PATCH /v1/objectives/{id}``. Unset fields are unchanged."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=256)
    description: str | None = None
    status: str | None = None
    due: str | None = None  # explicit null clears


class ProposeRequest(BaseModel):
    """Body for ``POST /v1/objectives/{id}/proposals``."""

    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1)
    plan: list[PlanItem] = Field(min_length=1, max_length=_MAX_PLAN_ITEMS)


class UpdateTaskRequest(BaseModel):
    """Body for ``PATCH /v1/objectives/{id}/tasks/{task_id}``."""

    model_config = ConfigDict(extra="forbid")

    status: str | None = None
    note: str | None = Field(default=None, max_length=2000)


def _proposal_to_response(p: ObjectiveProposal) -> dict[str, Any]:
    return {
        "id": p.id,
        "reason": p.reason,
        "plan": p.plan,
        "status": p.status,
        "created_at": p.created_at,
    }


def _to_response(o: Objective) -> dict[str, Any]:
    """Serialize an :class:`Objective` with its plan and open proposal."""
    return {
        "id": o.id,
        "parent_session_id": o.parent_session_id,
        "title": o.title,
        "description": o.description,
        "status": o.status,
        "due": o.due,
        "scheduled_task_id": o.scheduled_task_id,
        "created_at": o.created_at,
        "updated_at": o.updated_at,
        "plan": [
            {"id": t.id, "title": t.title, "status": t.status, "note": t.note} for t in o.tasks
        ],
        "open_proposal": (
            _proposal_to_response(o.open_proposal) if o.open_proposal is not None else None
        ),
    }


def _validate_due(due: str | None) -> None:
    if due is None:
        return
    try:
        datetime.fromisoformat(due)
    except ValueError:
        raise OmnigentError(
            "due must be an ISO-8601 date or datetime", code=ErrorCode.INVALID_INPUT
        ) from None


def _validate_status(status: str | None, allowed: tuple[str, ...], what: str) -> None:
    if status is not None and status not in allowed:
        raise OmnigentError(
            f"{what} must be one of {', '.join(allowed)}", code=ErrorCode.INVALID_INPUT
        )


def create_objectives_router(
    store: ObjectiveStore,
    *,
    scheduled_task_store: ScheduledTaskStore | None,
    agent_store: AgentStore,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    agent_cache: Any | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the objectives router, mounted with ``prefix="/v1"``.

    :param store: The shared :class:`ObjectiveStore`.
    :param scheduled_task_store: Store for the objective's cadence task and its
        runs; ``None`` rejects a cadence and serves an empty log.
    :param auth_provider: ``None`` disables auth (owner resolves to ``"local"``).
    :returns: A configured :class:`APIRouter`.
    """
    router = APIRouter()

    def _owner(request: Request) -> str:
        user_id = require_user(request, auth_provider)
        return user_id if user_id is not None else RESERVED_USER_LOCAL

    def _owner_id(owner: str) -> str | None:
        return None if owner == RESERVED_USER_LOCAL else owner

    def _scheduler(request: Request) -> Any | None:
        return getattr(request.app.state, "scheduled_task_scheduler", None)

    def _require_owned(objective_id: str, owner: str) -> Objective:
        """Load an objective the caller owns, or raise 404 (also for others')."""
        try:
            uuid_to_bytes(objective_id)
            objective = store.get(objective_id)
        except InvalidUuidError:
            objective = None
        if objective is None or objective.user_id != _owner_id(owner):
            raise OmnigentError("Objective not found", code=ErrorCode.NOT_FOUND)
        return objective

    async def _create_cadence_task(
        request: Request, owner: str, body: CreateObjectiveRequest, objective_id: str
    ) -> str:
        """Create the parent-bound ``goal`` scheduled task; returns its id."""
        from omnigent.server.routes._sessions.helpers import _require_declared_subagent

        assert body.rrule is not None and scheduled_task_store is not None
        parent = await asyncio.to_thread(
            conversation_store.get_conversation, body.parent_session_id
        )
        agent = (
            await asyncio.to_thread(agent_store.get, parent.agent_id)
            if parent is not None and parent.agent_id is not None
            else None
        )
        if agent is None:
            raise OmnigentError("parent session agent not found", code=ErrorCode.NOT_FOUND)
        await asyncio.to_thread(
            _require_declared_subagent,
            agent=agent,
            sub_agent_name=GOAL_AGENT_TYPE,
            agent_cache=agent_cache,
        )
        timezone = body.timezone
        if timezone is None:
            prefs = await asyncio.to_thread(scheduled_task_store.get_owner_preferences, owner)
            timezone = prefs.timezone if prefs is not None else "UTC"
        task = scheduled_task_store.create(
            scheduled_task_id=uuid.uuid4().hex,
            name=f"Goal: {body.title}"[:256],
            prompt=(
                f"Work on objective {objective_id}. Read it with objective_get, "
                "then advance one task."
            ),
            rrule=body.rrule,
            user_id=_owner_id(owner),
            agent_id=str(parent.agent_id),
            parent_session_id=body.parent_session_id,
            agent_type=GOAL_AGENT_TYPE,
            timezone=timezone,
        )
        scheduler = _scheduler(request)
        if scheduler is not None:
            scheduler.add(task)
        return task.id

    @router.post("/objectives")
    async def create_objective(request: Request, body: CreateObjectiveRequest) -> dict[str, Any]:
        """Create an objective, its first-plan proposal and (with ``rrule``) its cadence task."""
        owner = _owner(request)
        _validate_due(body.due)
        if body.rrule is not None:
            _validate_rrule_or_400(body.rrule)
            if body.timezone is not None:
                _validate_timezone_or_400(body.timezone)
            if scheduled_task_store is None:
                raise OmnigentError(
                    "scheduling is not available on this server", code=ErrorCode.INVALID_INPUT
                )
        if any(item.id is not None for item in body.plan):
            raise OmnigentError(
                "a first plan cannot reference existing tasks", code=ErrorCode.INVALID_INPUT
            )
        await require_access(
            _owner_id(owner),
            body.parent_session_id,
            LEVEL_OWNER,
            permission_store,
            conversation_store,
        )
        objective_id = uuid.uuid4().hex
        task_id = (
            await _create_cadence_task(request, owner, body, objective_id)
            if body.rrule is not None
            else None
        )
        try:
            await asyncio.to_thread(
                lambda: store.create(
                    objective_id,
                    user_id=_owner_id(owner),
                    parent_session_id=body.parent_session_id,
                    title=body.title,
                    description=body.description,
                    due=body.due,
                    scheduled_task_id=task_id,
                )
            )
        except Exception:
            if task_id is not None and scheduled_task_store is not None:
                scheduled_task_store.delete(task_id)
                scheduler = _scheduler(request)
                if scheduler is not None:
                    scheduler.remove(task_id)
            raise
        if body.plan:
            await asyncio.to_thread(
                lambda: store.set_open_proposal(
                    uuid.uuid4().hex,
                    objective_id,
                    reason=body.reason,
                    plan=[{"id": None, "title": i.title} for i in body.plan],
                )
            )
        fresh = await asyncio.to_thread(store.get, objective_id)
        assert fresh is not None
        return _to_response(fresh)

    @router.get("/objectives")
    async def list_objectives(
        request: Request, parent_session_id: str | None = Query(default=None)
    ) -> dict[str, list[dict[str, Any]]]:
        """List the caller's objectives, optionally for one parent session."""
        owner = _owner(request)
        if parent_session_id is not None:
            try:
                uuid_to_bytes(parent_session_id)
            except InvalidUuidError:
                return {"objectives": []}
        objectives = await asyncio.to_thread(
            lambda: store.list(owner_user_id=_owner_id(owner), parent_session_id=parent_session_id)
        )
        return {
            "objectives": [_to_response(o) for o in objectives if o.user_id == _owner_id(owner)]
        }

    @router.get("/objectives/{objective_id}")
    async def get_objective(request: Request, objective_id: str) -> dict[str, Any]:
        """Fetch one objective with its plan and open proposal."""
        return _to_response(_require_owned(objective_id, _owner(request)))

    @router.patch("/objectives/{objective_id}")
    async def update_objective(
        request: Request, objective_id: str, body: UpdateObjectiveRequest
    ) -> dict[str, Any]:
        """Update title, description, status or due; keeps the cadence task in step."""
        owner = _owner(request)
        existing = _require_owned(objective_id, owner)
        _validate_status(body.status, OBJECTIVE_STATUSES, "status")
        _validate_due(body.due)
        updated = await asyncio.to_thread(
            lambda: store.update(
                objective_id,
                title=body.title,
                description=body.description,
                status=body.status,
                due=body.due if "due" in body.model_fields_set else _UNSET,
            )
        )
        if updated is None:
            raise OmnigentError("Objective not found", code=ErrorCode.NOT_FOUND)
        if (
            body.status is not None
            and body.status != existing.status
            and updated.scheduled_task_id is not None
            and scheduled_task_store is not None
        ):
            state = "active" if body.status == "active" else "paused"
            task = await asyncio.to_thread(
                lambda: scheduled_task_store.update(updated.scheduled_task_id, state=state)
            )
            scheduler = _scheduler(request)
            if task is not None and scheduler is not None:
                scheduler.update(task)
        return _to_response(updated)

    @router.patch("/objectives/{objective_id}/tasks/{task_id}")
    async def update_objective_task(
        request: Request, objective_id: str, task_id: str, body: UpdateTaskRequest
    ) -> dict[str, Any]:
        """Set one task's status and/or note."""
        _require_owned(objective_id, _owner(request))
        _validate_status(body.status, OBJECTIVE_TASK_STATUSES, "status")
        try:
            uuid_to_bytes(task_id)
        except InvalidUuidError:
            raise OmnigentError("Task not found", code=ErrorCode.NOT_FOUND) from None
        task = await asyncio.to_thread(
            lambda: store.update_task(
                objective_id,
                task_id,
                status=body.status,
                note=body.note if "note" in body.model_fields_set else _UNSET,
            )
        )
        if task is None:
            raise OmnigentError("Task not found", code=ErrorCode.NOT_FOUND)
        return {"id": task.id, "title": task.title, "status": task.status, "note": task.note}

    @router.post("/objectives/{objective_id}/proposals")
    async def propose_plan(
        request: Request, objective_id: str, body: ProposeRequest
    ) -> dict[str, Any]:
        """Create or replace the objective's single open proposal."""
        _require_owned(objective_id, _owner(request))
        try:
            proposal = await asyncio.to_thread(
                lambda: store.set_open_proposal(
                    uuid.uuid4().hex,
                    objective_id,
                    reason=body.reason,
                    plan=[{"id": i.id, "title": i.title} for i in body.plan],
                )
            )
        except (ValueError, InvalidUuidError) as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from None
        return _proposal_to_response(proposal)

    async def _resolve(request: Request, objective_id: str, proposal_id: str, accept: bool) -> Any:
        _require_owned(objective_id, _owner(request))
        try:
            uuid_to_bytes(proposal_id)
            objective = await asyncio.to_thread(
                lambda: store.resolve_proposal(objective_id, proposal_id, accept=accept)
            )
        except InvalidUuidError:
            objective = None
        except ProposalNotOpenError:
            raise OmnigentError("proposal is no longer open", code=ErrorCode.CONFLICT) from None
        if objective is None:
            raise OmnigentError("Proposal not found", code=ErrorCode.NOT_FOUND)
        return _to_response(objective)

    @router.post("/objectives/{objective_id}/proposals/{proposal_id}/accept")
    async def accept_proposal(
        request: Request, objective_id: str, proposal_id: str
    ) -> dict[str, Any]:
        """Apply the proposed plan atomically; returns the updated objective."""
        return await _resolve(request, objective_id, proposal_id, True)

    @router.post("/objectives/{objective_id}/proposals/{proposal_id}/dismiss")
    async def dismiss_proposal(
        request: Request, objective_id: str, proposal_id: str
    ) -> dict[str, Any]:
        """Dismiss the proposal; returns the unchanged objective."""
        return await _resolve(request, objective_id, proposal_id, False)

    @router.get("/objectives/{objective_id}/log")
    async def objective_log(
        request: Request,
        objective_id: str,
        limit: int = Query(default=50, ge=1, le=_LOG_LIMIT_MAX),
    ) -> dict[str, list[dict[str, Any]]]:
        """The objective's Helper runs, newest first, each with its Result text."""
        from omnigent.server.routes._sessions.helpers import _latest_message_preview

        objective = _require_owned(objective_id, _owner(request))
        if objective.scheduled_task_id is None or scheduled_task_store is None:
            return {"log": []}
        task_id = objective.scheduled_task_id
        runs, _ = await asyncio.to_thread(
            lambda: scheduled_task_store.list_runs(task_id, limit=limit)
        )
        ids = [r.conversation_id for r in runs if r.conversation_id is not None]
        items = (
            await asyncio.to_thread(
                conversation_store.list_latest_message_items_for_conversations, ids, 10
            )
            if ids
            else {}
        )
        return {
            "log": [
                {
                    "run_id": r.id,
                    "status": r.status,
                    "scheduled_at": r.scheduled_at,
                    "fired_at": r.fired_at,
                    "finished_at": r.finished_at,
                    "error_code": r.error_code,
                    "attempt": r.attempt,
                    "conversation_id": r.conversation_id,
                    "result": (
                        _latest_message_preview(
                            items.get(r.conversation_id, []), _RESULT_PREVIEW_CHARS
                        )
                        if r.conversation_id is not None and r.status != "running"
                        else None
                    ),
                }
                for r in runs
            ]
        }

    return router
