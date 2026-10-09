"""``/v1/suggestions``: Ideas an agent proposes under a session, acted on from a UI.

A suggestion is a concrete next step (title, one-line why, the exact message to
send if accepted). A background run records them (via the ``suggestion_create``
tool, which calls ``POST``); the person accepts (``done``) or dismisses them
(``dismissed``) with ``PATCH``. Owner-scoped: another owner's rows 404.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.entities.suggestion import Suggestion
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.ideas.store import SqlAlchemySuggestionStore


class CreateSuggestionRequest(BaseModel):
    """Body of ``POST /v1/suggestions``."""

    model_config = ConfigDict(extra="forbid")

    parent_session_id: str
    title: str = Field(min_length=1, max_length=256)
    why: str = Field(min_length=1, max_length=1000)
    message: str = Field(min_length=1, max_length=4000)
    source_session_id: str | None = None


class UpdateSuggestionRequest(BaseModel):
    """Body of ``PATCH /v1/suggestions/{id}``."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["open", "done", "dismissed"]


def suggestion_to_response(item: Suggestion) -> dict[str, Any]:
    """Serialize a suggestion for the REST API."""
    return {
        "id": item.id,
        "parent_session_id": item.parent_session_id,
        "title": item.title,
        "why": item.why,
        "message": item.message,
        "status": item.status,
        "source_session_id": item.source_session_id,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _check_id(value: str, what: str) -> None:
    try:
        uuid_to_bytes(value)
    except InvalidUuidError as exc:
        raise OmnigentError(f"invalid {what}", code=ErrorCode.INVALID_INPUT) from exc


def create_suggestions_router(
    store: SqlAlchemySuggestionStore,
    *,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the suggestions router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str | None:
        user_id = require_user(request, auth_provider)
        owner = user_id if user_id is not None else RESERVED_USER_LOCAL
        return None if owner == RESERVED_USER_LOCAL else owner

    @router.post("/suggestions", status_code=201)
    async def create_suggestion(request: Request, body: CreateSuggestionRequest) -> dict[str, Any]:
        """Record a suggestion under a session the caller owns."""
        owner = _owner(request)
        _check_id(body.parent_session_id, "parent_session_id")
        if body.source_session_id is not None:
            _check_id(body.source_session_id, "source_session_id")
        await require_access(
            owner, body.parent_session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        item = await asyncio.to_thread(
            store.create,
            user_id=owner,
            parent_session_id=body.parent_session_id,
            title=body.title,
            why=body.why,
            message=body.message,
            source_session_id=body.source_session_id,
        )
        return suggestion_to_response(item)

    @router.get("/suggestions")
    async def list_suggestions(
        request: Request,
        parent_session_id: str | None = Query(default=None),
        status: Literal["open", "done", "dismissed"] | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        """List the caller's suggestions, newest first."""
        owner = _owner(request)
        if parent_session_id is not None:
            _check_id(parent_session_id, "parent_session_id")
        items = await asyncio.to_thread(
            store.list,
            user_id=owner,
            parent_session_id=parent_session_id,
            status=status,
            limit=limit,
        )
        return {"suggestions": [suggestion_to_response(i) for i in items]}

    @router.patch("/suggestions/{suggestion_id}")
    async def update_suggestion(
        request: Request, suggestion_id: str, body: UpdateSuggestionRequest
    ) -> dict[str, Any]:
        """Mark a suggestion open, done or dismissed."""
        owner = _owner(request)
        _check_id(suggestion_id, "suggestion id")
        item = await asyncio.to_thread(
            store.set_status, suggestion_id, user_id=owner, status=body.status
        )
        if item is None:
            raise OmnigentError("Suggestion not found", code=ErrorCode.NOT_FOUND)
        return suggestion_to_response(item)

    return router
