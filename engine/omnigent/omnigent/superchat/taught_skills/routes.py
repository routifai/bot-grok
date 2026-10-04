"""``/v1/taught-skills``: tasks the person taught by demonstration, reviewed and saved.

A skill starts when a recording starts (``POST /v1/sessions/{id}/computer/recording``), is drafted
by the ``teacher`` Helper once the recording stops, and is then edited (``PUT .../doc``, one new
version per write), saved, run (``POST .../render`` returns the text a turn follows) or deleted.
Owner-scoped: another owner's rows 404.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.db.utils import now_epoch
from omnigent.entities.taught_skill import TaughtSkill
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.superchat.taught_skills.doc import normalize_doc, render_skill, resolve_inputs
from omnigent.superchat.taught_skills.store import SqlAlchemyTaughtSkillStore
from omnigent.superchat.taught_skills.teach import expire_stale_draft

_MAX_DOC_BYTES = 64 * 1024


class SaveDocRequest(BaseModel):
    """Body of ``PUT /v1/taught-skills/{id}/doc``."""

    model_config = ConfigDict(extra="forbid")

    doc: dict[str, Any]


class RenderRequest(BaseModel):
    """Body of ``POST /v1/taught-skills/{id}/render``."""

    model_config = ConfigDict(extra="forbid")

    inputs: dict[str, Any] = Field(default_factory=dict)
    parent_session_id: str | None = None


def skill_to_response(skill: TaughtSkill, keyframes: list[str] | None = None) -> dict[str, Any]:
    """Serialize a skill for the REST API."""
    out: dict[str, Any] = {
        "id": skill.id,
        "parent_session_id": skill.parent_session_id,
        "recording_id": skill.recording_id,
        "name": skill.name,
        "goal": skill.goal,
        "status": skill.status,
        "version": skill.version,
        "doc": skill.doc,
        "created_at": skill.created_at,
        "updated_at": skill.updated_at,
        "stopped_at": skill.stopped_at,
    }
    if keyframes is not None:
        out["keyframes"] = keyframes
    return out


def _check_id(value: str, what: str) -> None:
    try:
        uuid_to_bytes(value)
    except InvalidUuidError as exc:
        raise OmnigentError(f"invalid {what}", code=ErrorCode.INVALID_INPUT) from exc


def create_taught_skills_router(
    store: SqlAlchemyTaughtSkillStore, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """Build the taught-skills router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str | None:
        user_id = require_user(request, auth_provider)
        owner = user_id if user_id is not None else RESERVED_USER_LOCAL
        return None if owner == RESERVED_USER_LOCAL else owner

    async def _skill(request: Request, skill_id: str) -> TaughtSkill:
        owner = _owner(request)
        _check_id(skill_id, "skill id")
        skill = await asyncio.to_thread(store.get_skill, skill_id, user_id=owner)
        if skill is None:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        return await asyncio.to_thread(expire_stale_draft, store, skill, now_epoch())

    @router.get("/taught-skills")
    async def list_skills(
        request: Request,
        parent_session_id: str | None = Query(default=None),
        status: Literal["recording", "drafting", "draft", "saved", "failed"] | None = Query(
            default=None
        ),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, Any]:
        """List the caller's skills, newest first."""
        owner = _owner(request)
        if parent_session_id is not None:
            _check_id(parent_session_id, "parent_session_id")
        skills = await asyncio.to_thread(
            store.list_skills,
            user_id=owner,
            parent_session_id=parent_session_id,
            status=status,
            limit=limit,
        )
        now = now_epoch()
        skills = [await asyncio.to_thread(expire_stale_draft, store, s, now) for s in skills]
        if status is not None:
            skills = [s for s in skills if s.status == status]
        return {"skills": [skill_to_response(s) for s in skills]}

    @router.get("/taught-skills/{skill_id}")
    async def get_skill(request: Request, skill_id: str) -> dict[str, Any]:
        """One skill with the names of its keyframes."""
        skill = await _skill(request, skill_id)
        names = (
            await asyncio.to_thread(store.keyframe_names, skill.recording_id)
            if skill.recording_id
            else []
        )
        return skill_to_response(skill, names)

    @router.get("/taught-skills/{skill_id}/keyframes/{name}")
    async def get_keyframe(request: Request, skill_id: str, name: str) -> Response:
        """One keyframe image of the skill's recording."""
        skill = await _skill(request, skill_id)
        jpeg = (
            await asyncio.to_thread(store.keyframe, skill.recording_id, name)
            if skill.recording_id
            else None
        )
        if jpeg is None:
            raise OmnigentError("Keyframe not found", code=ErrorCode.NOT_FOUND)
        return Response(content=jpeg, media_type="image/jpeg")

    @router.put("/taught-skills/{skill_id}/doc")
    async def save_doc(request: Request, skill_id: str, body: SaveDocRequest) -> dict[str, Any]:
        """Write a new version of the skill's document (the draft, or the person's edit)."""
        skill = await _skill(request, skill_id)
        if skill.status == "recording":
            raise OmnigentError("Stop teaching first", code=ErrorCode.CONFLICT)
        if len(json.dumps(body.doc)) > _MAX_DOC_BYTES:
            raise OmnigentError("skill is too large", code=ErrorCode.INVALID_INPUT)
        names = (
            set(await asyncio.to_thread(store.keyframe_names, skill.recording_id))
            if skill.recording_id
            else set()
        )
        try:
            doc = normalize_doc(body.doc, keyframes=names)
        except ValueError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
        saved = await asyncio.to_thread(store.save_doc, skill_id, user_id=skill.user_id, doc=doc)
        if saved is None:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        return skill_to_response(saved, sorted(names))

    @router.post("/taught-skills/{skill_id}/save")
    async def save_skill(request: Request, skill_id: str) -> dict[str, Any]:
        """Keep the draft: the Muse can run it from now on."""
        skill = await _skill(request, skill_id)
        if skill.doc is None or skill.status not in ("draft", "saved"):
            raise OmnigentError("Nothing to save yet", code=ErrorCode.CONFLICT)
        saved = await asyncio.to_thread(
            store.set_status, skill_id, user_id=skill.user_id, status="saved"
        )
        if saved is None:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        return skill_to_response(saved)

    @router.post("/taught-skills/{skill_id}/render")
    async def render(request: Request, skill_id: str, body: RenderRequest) -> dict[str, Any]:
        """The text a turn follows to run the skill, with this run's inputs filled in."""
        skill = await _skill(request, skill_id)
        if skill.doc is None or skill.status not in ("draft", "saved"):
            raise OmnigentError("This skill is not ready to run", code=ErrorCode.CONFLICT)
        if body.parent_session_id and body.parent_session_id != skill.parent_session_id:
            raise OmnigentError("Skill not found", code=ErrorCode.NOT_FOUND)
        values, missing = resolve_inputs(skill.doc, body.inputs)
        return {
            "skill_id": skill.id,
            "name": skill.name,
            "text": render_skill(skill.doc, values),
            "inputs": [
                {"name": i["name"], "label": i["label"], "value": values.get(i["name"], "")}
                for i in skill.doc.get("inputs", [])
            ],
            "missing_inputs": missing,
        }

    @router.delete("/taught-skills/{skill_id}", status_code=204)
    async def delete_skill(request: Request, skill_id: str) -> Response:
        """Delete the skill, its versions, its recording and its keyframes."""
        skill = await _skill(request, skill_id)
        await asyncio.to_thread(store.delete_skill, skill_id, user_id=skill.user_id)
        return Response(status_code=204)

    return router
