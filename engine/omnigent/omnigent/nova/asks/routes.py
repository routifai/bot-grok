"""REST API routes for Asks (``/v1/nova/asks``).

Owner-only throughout: every handler resolves the caller via
``actor_from_request`` and every service call is scoped to that actor's
``user_id`` — there is no cross-person read or write path here.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaDeps, actor_from_request
from omnigent.nova.asks import bridge, create_store
from omnigent.nova.asks.entities import Ask
from omnigent.nova.asks.service import AskService


class AnswerAskRequest(BaseModel):
    """Body of ``POST /asks/{ask_id}/answer``."""

    answer: str


def _to_response(ask: Ask) -> dict[str, Any]:
    """Serialize an Ask for the API, matching what ``useAsks.ts`` reads.

    :param ask: The Ask to serialize.
    """
    return {
        "id": ask.id,
        "kind": ask.kind.value,
        "status": ask.status.value,
        "text": ask.text,
        "detail": ask.detail,
        "choices": [{"id": action.id, "label": action.label} for action in ask.actions],
        "answer": ask.answer,
        "session_id": ask.session_id,
        "goal_id": ask.goal_id,
        "task_id": ask.task_id,
        "created_at": ask.created_at,
        "answered_at": ask.answered_at,
    }


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the Asks router, mounted under ``/v1/nova`` by ``_registry.py``.

    :param deps: Server-owned dependencies (see ``NovaDeps``).
    """
    router = APIRouter()
    service = AskService(create_store(deps.storage_location))

    @router.get("/asks")
    async def list_open(request: Request) -> dict[str, Any]:
        """The caller's open Asks, newest first.

        :raises OmnigentError: 401 if unauthenticated.
        """
        actor = actor_from_request(request, deps.auth_provider)
        if actor is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
        asks = service.list_open(actor)
        return {"object": "list", "data": [_to_response(a) for a in asks]}

    @router.post("/asks/{ask_id}/answer")
    async def answer(request: Request, ask_id: str, body: AnswerAskRequest) -> dict[str, Any]:
        """Answer one of the caller's open Asks.

        Resolves a still-live Omnigent elicitation, or delivers the answer
        as a normal session message when the elicitation has gone stale
        (see ``bridge.on_answered``).

        :raises OmnigentError: 401 if unauthenticated, 404 if the Ask
            doesn't exist or isn't the caller's own, 409 if already
            answered, 400 if ``answer`` isn't one of the offered options.
        """
        actor = actor_from_request(request, deps.auth_provider)
        if actor is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
        ask = service.answer(actor, ask_id, body.answer)
        await bridge.on_answered(ask, body.answer)
        return _to_response(ask)

    return router
