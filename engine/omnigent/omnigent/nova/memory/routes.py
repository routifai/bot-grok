"""REST routes for Nova's memory primitive.

Mounted by ``_registry.include_routers`` under ``/v1/nova``; the paths below
carry no prefix of their own.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, NovaDeps, actor_from_request
from omnigent.nova.memory import create_store
from omnigent.nova.memory.entities import MemoryNote, Profile
from omnigent.nova.memory.store import MemoryStore


class UpdateNoteRequest(BaseModel):
    """Body of ``PUT /memory/{note_id}``."""

    content: str


class UpdateProfileRequest(BaseModel):
    """Body of ``PUT /memory/profile``."""

    timezone: str


def _note_response(note: MemoryNote) -> dict[str, Any]:
    """Serialize a :class:`MemoryNote` for the API."""
    return {
        "id": note.id,
        "object": "memory.note",
        "kind": note.kind.value,
        "path": note.path,
        "content": note.content,
        "revision": note.revision,
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def _profile_response(profile: Profile) -> dict[str, Any]:
    """Serialize a :class:`Profile` for the API."""
    return {
        "timezone": profile.timezone,
        "display_name": profile.display_name,
        "updated_at": profile.updated_at,
    }


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the memory router.

    :param deps: Server-owned dependencies (storage location, auth provider).
    :returns: A configured :class:`APIRouter`.
    """
    router = APIRouter()
    store: MemoryStore = create_store(deps.storage_location)

    def _actor(request: Request) -> NovaActor:
        """Resolve the caller, or raise 401 when unauthenticated."""
        actor = actor_from_request(request, deps.auth_provider)
        if actor is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
        return actor

    @router.get("/memory")
    async def list_memory(request: Request) -> dict[str, Any]:
        """List the caller's notes."""
        actor = _actor(request)
        notes = await asyncio.to_thread(store.list_notes, actor)
        return {"object": "list", "data": [_note_response(n) for n in notes]}

    @router.get("/memory/export")
    async def export_memory(request: Request) -> Response:
        """Every note as one markdown document, one ``# <path>`` section each."""
        actor = _actor(request)
        notes = await asyncio.to_thread(store.list_notes, actor)
        markdown = "\n\n".join(f"# {note.path}\n\n{note.content}" for note in notes)
        return Response(content=markdown, media_type="text/markdown")

    @router.get("/memory/profile")
    async def get_memory_profile(request: Request) -> dict[str, Any]:
        """The caller's Nova profile."""
        actor = _actor(request)
        profile = await asyncio.to_thread(store.get_profile, actor)
        return _profile_response(profile)

    # Declared before the "/memory/{note_id}" PUT below: both are PUT, and
    # Starlette matches routes in declaration order, so the literal path must
    # come first or "/memory/profile" would never be reached.
    @router.put("/memory/profile")
    async def update_memory_profile(
        request: Request, body: UpdateProfileRequest
    ) -> dict[str, Any]:
        """Set the caller's timezone."""
        actor = _actor(request)
        profile = await asyncio.to_thread(store.set_timezone, actor, body.timezone)
        return _profile_response(profile)

    @router.put("/memory/{note_id}")
    async def update_memory(
        request: Request, note_id: str, body: UpdateNoteRequest
    ) -> dict[str, Any]:
        """Replace a note's content, recording a new revision."""
        actor = _actor(request)
        note = await asyncio.to_thread(store.get, actor, note_id)
        if note is None:
            raise OmnigentError("Memory note not found", code=ErrorCode.NOT_FOUND)
        updated = await asyncio.to_thread(store.save, actor, note.kind, note.path, body.content)
        return _note_response(updated)

    return router
