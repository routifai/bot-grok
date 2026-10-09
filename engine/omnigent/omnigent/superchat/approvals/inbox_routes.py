"""``/v1/me/asks``: the decisions waiting on the person, and how to answer them.

* ``GET /me/asks`` -> ``{"data": [ask]}``, newest first: pending approvals, open plan proposals
  and blocked tasks of the caller's active Goals (see :mod:`omnigent.superchat.approvals.asks`),
  redacted of the secrets the engine knows (:mod:`omnigent.server.redaction`).
* ``POST /me/asks/{id}/answer`` ``{choice, note?}`` -> ``{"ok": true}``. Dispatches to the
  approval answer function and the objective store, the same code the underlying routes run;
  ownership is checked exactly as they do.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.entities import Objective
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.redaction import request_redactor
from omnigent.server.routes._auth_helpers import require_user
from omnigent.stores import AgentStore, ConversationStore, PermissionStore
from omnigent.stores.objective_store import ObjectiveStore, ProposalNotOpenError
from omnigent.superchat.approvals.asks import (
    approval_ask,
    approval_decision,
    objective_asks,
    parse_ask_id,
    proposal_accepts,
)
from omnigent.superchat.approvals.routes import answer_approval, owner_of

_NOTE_MAX = 2000


class AskAnswer(BaseModel):
    """Body of ``POST /v1/me/asks/{id}/answer``."""

    model_config = ConfigDict(extra="forbid")

    choice: str = Field(min_length=1, max_length=64)
    note: str | None = Field(default=None, max_length=_NOTE_MAX)


def _not_found() -> OmnigentError:
    return OmnigentError("Ask not found", code=ErrorCode.NOT_FOUND)


def create_asks_router(
    *,
    objective_store: ObjectiveStore | None,
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    runner_router: RunnerRouter | None,
    permission_store: PermissionStore | None,
    auth_provider: AuthProvider | None,
) -> APIRouter:
    """Build the asks router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _objective_owner(user_id: str | None) -> str | None:
        return None if user_id in (None, RESERVED_USER_LOCAL) else user_id

    def _owned_objective(objective_id: str, user_id: str | None) -> Objective:
        if objective_store is None:
            raise _not_found()
        try:
            uuid_to_bytes(objective_id)
            objective = objective_store.get(objective_id)
        except InvalidUuidError:
            objective = None
        if objective is None or objective.user_id != _objective_owner(user_id):
            raise _not_found()
        return objective

    @router.get("/me/asks")
    async def list_asks(request: Request) -> dict[str, Any]:
        """Everything waiting on the caller, newest first."""
        user_id = require_user(request, auth_provider)
        asks: list[dict[str, Any]] = []
        approvals = getattr(request.app.state, "approval_store", None)
        if approvals is not None:
            owner = owner_of(user_id)
            rows = await asyncio.to_thread(approvals.list_pending, user_id=owner)
            cap = await asyncio.to_thread(approvals.get_cap, owner)
            asks += [approval_ask(row, cap) for row in rows]
        if objective_store is not None:
            owner_id = _objective_owner(user_id)
            objectives = await asyncio.to_thread(
                lambda: objective_store.list(owner_user_id=owner_id)
            )
            for objective in objectives:
                if objective.user_id == owner_id and objective.status == "active":
                    asks += objective_asks(objective)
        asks.sort(key=lambda ask: (ask["created_at"] or 0, ask["id"]), reverse=True)
        return request_redactor(request, user_id).deep({"data": asks})

    @router.post("/me/asks/{ask_id}/answer")
    async def answer_ask(request: Request, ask_id: str, body: AskAnswer) -> dict[str, bool]:
        """Answer one ask with one of its choice ids."""
        user_id = require_user(request, auth_provider)
        parsed = parse_ask_id(ask_id)
        if parsed is None:
            raise _not_found()
        prefix, parts = parsed
        if prefix == "approval":
            decision = approval_decision(body.choice)
            approvals = getattr(request.app.state, "approval_store", None)
            if approvals is None:
                raise _not_found()
            if decision is None:
                raise OmnigentError("Unknown choice", code=ErrorCode.INVALID_INPUT)
            await answer_approval(
                approvals,
                owner=owner_of(user_id),
                user_id=user_id,
                elicitation_id=parts[0],
                decision=decision,  # type: ignore[arg-type]
                conversation_store=conversation_store,
                agent_store=agent_store,
                runner_router=runner_router,
                permission_store=permission_store,
            )
            return {"ok": True}
        objective_id, item_id = parts
        objective = _owned_objective(objective_id, user_id)
        assert objective_store is not None
        if prefix == "proposal":
            accept = proposal_accepts(body.choice)
            if accept is None:
                raise OmnigentError("Unknown choice", code=ErrorCode.INVALID_INPUT)
            try:
                uuid_to_bytes(item_id)
                resolved = await asyncio.to_thread(
                    lambda: objective_store.resolve_proposal(objective_id, item_id, accept=accept)
                )
            except InvalidUuidError:
                resolved = None
            except ProposalNotOpenError:
                raise OmnigentError(
                    "proposal is no longer open", code=ErrorCode.CONFLICT
                ) from None
            if resolved is None:
                raise _not_found()
            return {"ok": True}
        # Blocked task: the reply goes into its note and the task goes back to pending, which
        # is how the Goal's next run picks it up.
        if body.choice != "answer":
            raise OmnigentError("Unknown choice", code=ErrorCode.INVALID_INPUT)
        reply = (body.note or "").strip()
        if not reply:
            raise OmnigentError("An answer needs a note", code=ErrorCode.INVALID_INPUT)
        task = next(
            (t for t in objective.tasks if t.id == item_id and t.status == "blocked"), None
        )
        if task is None:
            raise _not_found()
        note = f"{task.note}\n\nAnswer: {reply}" if task.note else f"Answer: {reply}"
        await asyncio.to_thread(
            lambda: objective_store.update_task(
                objective_id, item_id, status="pending", note=note[:_NOTE_MAX]
            )
        )
        return {"ok": True}

    return router
