"""``/v1/artifacts/{id}/live`` (the person's side) and ``/v1/live-artifacts/*`` (the Helper's).

The artifact id is any version of the family. Owner-scoped like the artifact routes: another
owner's rows 404.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.server.scheduled.rrule import RRuleValidationError, validate_rrule
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.artifact_kinds import is_deck_name
from omnigent.superchat.artifacts import (
    Artifact,
    artifact_to_response,
    check_id,
    load_artifact,
    request_owner,
)
from omnigent.superchat.live.service import LiveService
from omnigent.superchat.live.store import Live


class Source(BaseModel):
    """One place a page's facts come from: a web page URL or a Computer file path."""

    model_config = ConfigDict(extra="forbid")

    ref: str = Field(min_length=1, max_length=2048)
    label: str = Field(default="", max_length=256)


class LiveBody(BaseModel):
    """``PUT /artifacts/{id}/live`` body."""

    model_config = ConfigDict(extra="forbid")

    rrule: str
    timezone: str | None = None
    sources: list[Source] | None = Field(default=None, max_length=50)
    tell: Literal["notable", "every", "never"] | None = None
    follow_publish: bool | None = None


class AcceptBody(BaseModel):
    """``POST /artifacts/{id}/live/accept`` body."""

    element_id: str


class Change(BaseModel):
    """One fact the Helper found different in a source."""

    model_config = ConfigDict(extra="forbid")

    id: str
    after: str
    source: str | None = None
    notable: bool = False


class SaveBody(BaseModel):
    """``POST /live-artifacts/save`` body."""

    model_config = ConfigDict(extra="forbid")

    base_version: int = Field(ge=1)
    changes: list[Change] = Field(max_length=200)
    facts: dict[str, Any]
    sources: list[Source] | None = Field(default=None, max_length=50)


class CheckedBody(BaseModel):
    """``POST /live-artifacts/checked`` body."""

    model_config = ConfigDict(extra="forbid")

    facts: dict[str, Any]


def _sources(sources: list[Source] | None) -> list[dict[str, str]] | None:
    return (
        None if sources is None else [{"ref": s.ref, "label": s.label or s.ref} for s in sources]
    )


def create_live_router(
    service: LiveService,
    *,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the live artifacts router, mounted with ``prefix="/v1"``."""
    router = APIRouter()
    artifacts = service.artifacts

    def _config(live: Live) -> dict[str, Any]:
        task = service.tasks.get(live.task_id)
        state = live.state
        return {
            "task_id": live.task_id,
            "rrule": task.rrule if task else None,
            "timezone": task.timezone if task else None,
            "schedule": task.state if task else "missing",
            "last_run_at": task.last_run_at if task else None,
            "sources": live.sources,
            "tell": live.tell,
            "follow_publish": live.follow_publish,
            "checked_at": state["checked_at"],
            "open_issue": state["open_issue"],
            "last_update": state["last_update"],
        }

    async def _live_item(request: Request, artifact_id: str) -> Artifact:
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        if item.kind != "html" or is_deck_name(item.name):
            raise OmnigentError("Only a page can be kept updated", code=ErrorCode.INVALID_INPUT)
        return item

    async def _named(request: Request, parent_session_id: str, name: str) -> Artifact:
        """The newest version of a page the caller (a Helper of the chat) may update."""
        check_id(parent_session_id, "parent_session_id")
        await require_access(
            require_user(request, auth_provider),
            parent_session_id,
            LEVEL_OWNER,
            permission_store,
            conversation_store,
        )
        group = await asyncio.to_thread(
            artifacts.versions_of,
            user_id=request_owner(request, auth_provider),
            parent_session_id=parent_session_id,
            name=name,
        )
        if not group:
            raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
        return group[0]

    @router.get("/artifacts/{artifact_id}/live")
    async def get_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """The live configuration and what the last update did, or ``{"live": null}``."""
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        live = await asyncio.to_thread(service.live.get, item.parent_session_id, item.name)
        if live is None:
            return {"live": None}
        return {"live": await asyncio.to_thread(_config, live)}

    @router.put("/artifacts/{artifact_id}/live")
    async def put_live(request: Request, artifact_id: str, body: LiveBody) -> dict[str, Any]:
        """Keep the page updated on a schedule (create or change it)."""
        item = await _live_item(request, artifact_id)
        try:
            validate_rrule(body.rrule)
        except RRuleValidationError as exc:
            raise OmnigentError(f"invalid rrule: {exc}", code=ErrorCode.INVALID_INPUT) from exc
        if body.timezone is not None:
            try:
                ZoneInfo(body.timezone)
            except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
                raise OmnigentError(
                    f"invalid timezone {body.timezone!r}", code=ErrorCode.INVALID_INPUT
                ) from exc
        live = await asyncio.to_thread(
            lambda: service.upsert(
                item,
                rrule=body.rrule,
                timezone=body.timezone,
                sources=_sources(body.sources),
                tell=body.tell,
                follow_publish=body.follow_publish,
            )
        )
        return {"live": await asyncio.to_thread(_config, live)}

    @router.delete("/artifacts/{artifact_id}/live")
    async def delete_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """Stop updating: the schedule and the row go, the versions stay."""
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        return {"deleted": await asyncio.to_thread(service.remove, item)}

    @router.post("/artifacts/{artifact_id}/live/run", status_code=202)
    async def run_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """Update now: fire the page's scheduled task."""
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        live = await asyncio.to_thread(service.need_live, item)
        run_now = getattr(request.app.state, "scheduled_task_run_now", None)
        task = await asyncio.to_thread(service.tasks.get, live.task_id)
        if run_now is None or task is None:
            raise OmnigentError(
                "scheduled task scheduler is not running", code=ErrorCode.RUNNER_UNAVAILABLE
            )
        if not await run_now(task.workspace_id, task.id):
            raise OmnigentError("an update is already running", code=ErrorCode.CONFLICT)
        return {"triggered": True}

    @router.post("/artifacts/{artifact_id}/live/undo")
    async def undo_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """Undo the newest update (only while it is still the newest version)."""
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        created = await asyncio.to_thread(service.undo, item)
        return artifact_to_response(created, versions=created.version)

    @router.post("/artifacts/{artifact_id}/live/accept")
    async def accept_live(request: Request, artifact_id: str, body: AcceptBody) -> dict[str, Any]:
        """Take the source's value for a part the person had changed."""
        item = await load_artifact(artifacts, request_owner(request, auth_provider), artifact_id)
        created = await asyncio.to_thread(service.accept, item, body.element_id)
        return artifact_to_response(created, versions=created.version)

    @router.get("/live-artifacts/context")
    async def live_context(
        request: Request, parent_session_id: str = Query(), name: str = Query()
    ) -> dict[str, Any]:
        """What an update run needs before it reads the sources (called by the Helper)."""
        item = await _named(request, parent_session_id, name)
        return await asyncio.to_thread(service.context, item)

    @router.post("/live-artifacts/save")
    async def live_save(
        request: Request,
        body: SaveBody,
        parent_session_id: str = Query(),
        name: str = Query(),
    ) -> dict[str, Any]:
        """Apply a run's changes as one ``update`` version (called by the Helper)."""
        item = await _named(request, parent_session_id, name)
        return await asyncio.to_thread(
            lambda: service.save(
                item,
                base_version=body.base_version,
                changes=[c.model_dump() for c in body.changes],
                facts=body.facts,
                sources=_sources(body.sources),
            )
        )

    @router.post("/live-artifacts/checked")
    async def live_checked(
        request: Request,
        body: CheckedBody,
        parent_session_id: str = Query(),
        name: str = Query(),
    ) -> dict[str, Any]:
        """A run that found nothing new (called by the Helper)."""
        item = await _named(request, parent_session_id, name)
        return await asyncio.to_thread(service.checked, item, body.facts)

    return router
