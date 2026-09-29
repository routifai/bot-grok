"""REST routes for Nova's skills primitive (``/skills*``, mounted under ``/v1/nova``).

Every route is scoped to the caller (``nova/README.md`` rule 3 — private
stays private): there is no cross-person access, and no ACL to check.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, NovaDeps, actor_from_request
from omnigent.nova.skills import create_store
from omnigent.nova.skills.entities import Skill, SkillOffer
from omnigent.nova.skills.service import SkillService


def _require_actor(request: Request, deps: NovaDeps) -> NovaActor:
    """Resolve the caller or raise 401.

    :raises OmnigentError: ``UNAUTHORIZED`` if the request has no identity.
    """
    actor = actor_from_request(request, deps.auth_provider)
    if actor is None:
        raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)
    return actor


def _skill_response(skill: Skill) -> dict[str, Any]:
    return {
        "id": skill.id,
        "object": "skill",
        "name": skill.name,
        "description": skill.description,
        "content": skill.content,
        "created_at": skill.created_at,
        "updated_at": skill.updated_at,
    }


def _offer_response(offer: SkillOffer) -> dict[str, Any]:
    return {
        "id": offer.id,
        "object": "skill.offer",
        "name": offer.name,
        "description": offer.description,
        "content": offer.content,
        "status": offer.status.value,
        "created_at": offer.created_at,
        "decided_at": offer.decided_at,
    }


def create_router(deps: NovaDeps) -> APIRouter:
    """Build the skills router.

    :param deps: Server-owned dependencies (storage location, auth provider).
    :returns: A configured :class:`APIRouter`, mounted at ``/v1/nova`` by
        ``omnigent.nova._registry.include_routers``.
    """
    service = SkillService(create_store(deps.storage_location))
    router = APIRouter()

    @router.get("/skills")
    async def list_skills(request: Request) -> dict[str, Any]:
        """List the caller's saved skills."""
        actor = _require_actor(request, deps)
        skills = await asyncio.to_thread(service.list_skills, actor)
        return {"object": "list", "data": [_skill_response(s) for s in skills]}

    # Declared before "/skills/{name}": "offers" would otherwise be matched
    # as a skill name, since Starlette matches routes in declaration order.
    @router.get("/skills/offers")
    async def list_offers(request: Request) -> dict[str, Any]:
        """List the caller's open skill offers."""
        actor = _require_actor(request, deps)
        offers = await asyncio.to_thread(service.open_offers, actor)
        return {"object": "list", "data": [_offer_response(o) for o in offers]}

    @router.post("/skills/offers/{offer_id}/save")
    async def save_offer(request: Request, offer_id: str) -> dict[str, Any]:
        """Accept an open offer: saves the skill.

        :raises OmnigentError: 401 unauthenticated, 404 unknown offer, 409 if
            it was already answered.
        """
        actor = _require_actor(request, deps)
        skill = await asyncio.to_thread(service.accept_offer, actor, offer_id)
        return _skill_response(skill)

    @router.post("/skills/offers/{offer_id}/dismiss")
    async def dismiss_offer(request: Request, offer_id: str) -> dict[str, Any]:
        """Decline an open offer.

        :raises OmnigentError: 401 unauthenticated, 404 unknown offer, 409 if
            it was already answered.
        """
        actor = _require_actor(request, deps)
        offer = await asyncio.to_thread(service.dismiss_offer, actor, offer_id)
        return _offer_response(offer)

    @router.get("/skills/{name}")
    async def get_skill(request: Request, name: str) -> dict[str, Any]:
        """Fetch one of the caller's skills by exact name.

        :raises OmnigentError: 401 unauthenticated, 404 if not found / not owned.
        """
        actor = _require_actor(request, deps)
        skill = await asyncio.to_thread(service.get, actor, name)
        if skill is None:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        return _skill_response(skill)

    @router.delete("/skills/{name}")
    async def delete_skill(request: Request, name: str) -> dict[str, Any]:
        """Delete one of the caller's skills by exact name.

        :raises OmnigentError: 401 unauthenticated, 404 if not found / not owned.
        """
        actor = _require_actor(request, deps)
        removed = await asyncio.to_thread(service.delete, actor, name)
        if not removed:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        return {"name": name, "object": "skill.deleted", "deleted": True}

    return router
