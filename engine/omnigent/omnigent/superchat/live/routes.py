"""``/v1/artifacts/{id}/live``: settings, undo, accept; ``/context`` + ``/save`` for the Helper.

The artifact id is any version of the page. Owner-scoped like the artifact routes (another
owner's rows 404); in single-user mode the rows are unowned and so is the lookup.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.scheduled.rrule import RRuleValidationError, validate_rrule
from omnigent.superchat.artifact_kinds import is_deck_name
from omnigent.superchat.artifacts import (
    Artifact,
    artifact_to_response,
    load_artifact,
    request_owner,
)
from omnigent.superchat.live.service import LiveService

#: A web page URL or a Computer file path a page's facts come from.
Sources = Annotated[
    list[Annotated[str, Field(min_length=1, max_length=2048)]], Field(max_length=50)
]


class LiveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rrule: str
    sources: Sources | None = None
    tell: Literal["notable", "every", "never"] | None = None
    follow_publish: bool | None = None


class Change(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    after: str
    source: str | None = None
    notable: bool = False


class SaveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_version: int = Field(ge=1)
    changes: list[Change] = Field(default_factory=list, max_length=200)
    facts: dict[str, Any] = Field(default_factory=dict)
    sources: Sources | None = None


def create_live_router(
    service: LiveService, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """Build the live artifacts router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _describe(item: Artifact) -> dict[str, Any]:
        live = service.live.get(item.parent_session_id, item.name)
        if live is None:
            return {"live": None}
        task = service.tasks.get(live.task_id)
        return {
            "live": {
                "task_id": live.task_id,
                "rrule": task.rrule if task else None,
                "timezone": task.timezone if task else None,
                "schedule": task.state if task else "missing",
                "last_run_at": task.last_run_at if task else None,
                "sources": live.sources,
                "tell": live.tell,
                "follow_publish": live.follow_publish,
                **{k: live.state[k] for k in ("checked_at", "open_issue", "last_update")},
            }
        }

    async def _page(request: Request, artifact_id: str) -> Artifact:
        return await load_artifact(
            service.artifacts, request_owner(request, auth_provider), artifact_id
        )

    @router.get("/artifacts/{artifact_id}/live")
    async def get_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """The page's live settings and what the last update did, or ``{"live": null}``."""
        return await asyncio.to_thread(_describe, await _page(request, artifact_id))

    @router.put("/artifacts/{artifact_id}/live")
    async def put_live(request: Request, artifact_id: str, body: LiveBody) -> dict[str, Any]:
        """Keep the page updated on a schedule (create or change it)."""
        item = await _page(request, artifact_id)
        if item.kind != "html" or is_deck_name(item.name):
            raise OmnigentError("Only a page can be kept updated", code=ErrorCode.INVALID_INPUT)
        try:
            validate_rrule(body.rrule)
        except RRuleValidationError as exc:
            raise OmnigentError(f"invalid rrule: {exc}", code=ErrorCode.INVALID_INPUT) from exc
        fields = body.model_dump(exclude={"rrule"})
        await asyncio.to_thread(lambda: service.upsert(item, rrule=body.rrule, **fields))
        return await asyncio.to_thread(_describe, item)

    @router.delete("/artifacts/{artifact_id}/live")
    async def delete_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """Stop updating: the schedule and the row go, the versions stay."""
        item = await _page(request, artifact_id)
        return {"deleted": await asyncio.to_thread(service.remove, item)}

    @router.post("/artifacts/{artifact_id}/live/run", status_code=202)
    async def run_live(request: Request, artifact_id: str) -> dict[str, Any]:
        """Update now: fire the page's scheduled task."""
        live, _ = await asyncio.to_thread(service.need, await _page(request, artifact_id))
        task = await asyncio.to_thread(service.tasks.get, live.task_id)
        run_now = getattr(request.app.state, "scheduled_task_run_now", None)
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
        created = await asyncio.to_thread(service.undo, await _page(request, artifact_id))
        return artifact_to_response(created, versions=created.version)

    @router.post("/artifacts/{artifact_id}/live/accept")
    async def accept_live(
        request: Request, artifact_id: str, element_id: str = Body(embed=True)
    ) -> dict[str, Any]:
        """Take the source's value for a part the person had changed."""
        item = await _page(request, artifact_id)
        created = await asyncio.to_thread(service.accept, item, element_id)
        return artifact_to_response(created, versions=created.version)

    @router.get("/artifacts/{artifact_id}/live/context")
    async def live_context(request: Request, artifact_id: str) -> dict[str, Any]:
        """What an update run (the Helper) needs before it reads the sources."""
        return await asyncio.to_thread(service.context, await _page(request, artifact_id))

    @router.post("/artifacts/{artifact_id}/live/save")
    async def live_save(request: Request, artifact_id: str, body: SaveBody) -> dict[str, Any]:
        """An update run's outcome: at most one ``update`` version."""
        item = await _page(request, artifact_id)
        changes = [c.model_dump() for c in body.changes]
        return await asyncio.to_thread(
            lambda: service.save(
                item,
                base_version=body.base_version,
                changes=changes,
                facts=body.facts,
                sources=body.sources,
            )
        )

    return router
