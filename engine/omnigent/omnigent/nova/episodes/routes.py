"""REST routes for episodes (``/v1/nova/episodes``)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Query, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaDeps, actor_from_request
from omnigent.nova.episodes import _runtime
from omnigent.nova.episodes.entities import Episode

_DEFAULT_LIMIT = 20
_MAX_LIMIT = 200


def _to_response(episode: Episode) -> dict[str, Any]:
    """Convert an :class:`Episode` entity to its API response shape.

    :param episode: The entity to convert.
    :returns: A JSON-serializable dict.
    """
    return {
        "id": episode.id,
        "object": "nova.episode",
        "session_id": episode.session_id,
        "title": episode.title,
        "summary": episode.summary,
        "tools": list(episode.tools),
        "links": list(episode.links),
        "created_at": episode.created_at,
        "updated_at": episode.updated_at,
    }


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the episodes router (``/v1/nova/episodes``).

    :param deps: Server-owned dependencies; also configures the store this
        primitive's tool and turn-completion observer read
        (see ``_runtime.py``).
    :returns: A configured :class:`APIRouter`.
    """
    _runtime.configure(deps.storage_location)
    store = _runtime.store()
    assert store is not None  # configure() above always sets it
    router = APIRouter()

    @router.get("/episodes")
    async def list_episodes(
        request: Request,
        limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    ) -> dict[str, Any]:
        """List the caller's episodes, newest first.

        :param request: The incoming request, used to identify the caller.
        :param limit: Maximum number of episodes to return.
        :returns: ``{"object": "list", "data": [...]}``.
        :raises OmnigentError: 401 if unauthenticated.
        """
        actor = actor_from_request(request, deps.auth_provider)
        if actor is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
        episodes = await asyncio.to_thread(store.list_recent, actor=actor, limit=limit)
        return {"object": "list", "data": [_to_response(e) for e in episodes]}

    @router.delete("/episodes/{episode_id}")
    async def delete_episode(request: Request, episode_id: str) -> dict[str, Any]:
        """Delete one of the caller's episodes.

        :param request: The incoming request, used to identify the caller.
        :param episode_id: The episode to delete.
        :returns: ``{"id": ..., "object": "nova.episode.deleted", "deleted": True}``.
        :raises OmnigentError: 401 if unauthenticated, 404 if not found / not
            owned by the caller.
        """
        actor = actor_from_request(request, deps.auth_provider)
        if actor is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
        deleted = await asyncio.to_thread(store.delete, episode_id, actor=actor)
        if not deleted:
            raise OmnigentError("Episode not found", code=ErrorCode.NOT_FOUND)
        return {"id": episode_id, "object": "nova.episode.deleted", "deleted": True}

    return router
