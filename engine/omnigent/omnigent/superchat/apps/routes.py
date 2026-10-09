"""``/v1/artifacts/{id}/publish`` and ``/v1/published/{slug}``: a saved HTML file as a web app.

Publishing is a state on top of an artifact (the publication rows live in the artifacts store),
so this router resolves the artifact through the artifacts capability and adds the app routes.
``/published/*`` is gateway-only: the Nova API's ``/apps/<slug>`` gateway checks the viewer
against the audience first.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.superchat.artifacts import (
    AUDIENCES,
    Artifact,
    SqlAlchemyArtifactStore,
    load_artifact,
    publication_to_response,
    request_owner,
)

#: The identity the Nova API's ``/apps/<slug>`` gateway calls ``/v1/published`` with. Only this
#: caller may read published bytes or record views: it checks the viewer's audience first.
PUBLISHED_GATEWAY_USER_DEFAULT = "nova-apps-gateway@nova.invalid"


def published_gateway_user() -> str:
    """:returns: The configured gateway identity (``OMNIGENT_PUBLISHED_GATEWAY_USER``)."""
    return os.environ.get("OMNIGENT_PUBLISHED_GATEWAY_USER") or PUBLISHED_GATEWAY_USER_DEFAULT


class PublishBody(BaseModel):
    """``POST /artifacts/{id}/publish`` body."""

    audience: str = Field(max_length=8)
    version: int | None = Field(default=None, ge=1)


class ViewBody(BaseModel):
    """``POST /published/{slug}/view`` body."""

    viewer_key: str = Field(min_length=1, max_length=64)


def create_apps_router(
    store: SqlAlchemyArtifactStore, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """Build the apps router, mounted with ``prefix="/v1"`` after the artifacts router."""
    router = APIRouter()

    async def _load(request: Request, artifact_id: str) -> Artifact:
        return await load_artifact(store, request_owner(request, auth_provider), artifact_id)

    async def _publish_state(item: Artifact) -> dict[str, Any]:
        pub = await asyncio.to_thread(store.publication_for, item)
        if pub is None:
            return {"published": False, "publish": None}
        stats = (await asyncio.to_thread(store.stats, [pub.slug])).get(pub.slug)
        return {"published": True, "publish": publication_to_response(pub, stats)}

    @router.post("/artifacts/{artifact_id}/publish")
    async def publish_artifact(
        request: Request, artifact_id: str, body: PublishBody
    ) -> dict[str, Any]:
        """Publish (or republish) a deliverable as a web app; owner-only, html only.

        Republishing keeps the address and re-pins the served version (default newest).
        """
        item = await _load(request, artifact_id)
        if body.audience not in AUDIENCES:
            raise OmnigentError(
                f"audience must be one of: {', '.join(AUDIENCES)}", code=ErrorCode.INVALID_INPUT
            )
        if item.kind != "html":
            raise OmnigentError("only html files can be published", code=ErrorCode.INVALID_INPUT)
        try:
            pub = await asyncio.to_thread(
                store.publish, item, audience=body.audience, version=body.version
            )
        except ValueError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
        stats = (await asyncio.to_thread(store.stats, [pub.slug])).get(pub.slug)
        return publication_to_response(pub, stats)

    @router.delete("/artifacts/{artifact_id}/publish")
    async def unpublish_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Take the app offline (its address stops working); owner-only."""
        item = await _load(request, artifact_id)
        removed = await asyncio.to_thread(store.unpublish, item)
        return {"unpublished": removed}

    @router.get("/artifacts/{artifact_id}/publish")
    async def get_publish_state(request: Request, artifact_id: str) -> dict[str, Any]:
        """The publish state plus view stats; owner-only."""
        return await _publish_state(await _load(request, artifact_id))

    def _require_gateway(request: Request) -> None:
        if auth_provider is None:
            return
        caller = require_user(request, auth_provider)
        if caller != published_gateway_user():
            raise OmnigentError("Not found", code=ErrorCode.NOT_FOUND)

    @router.get("/published/{slug}")
    async def read_published(request: Request, slug: str) -> Response:
        """The pinned HTML bytes of a published app plus its audience and owner.

        Gateway-only: the Nova API checks the viewer against the audience first. The viewer-facing
        security headers are the gateway's job; this response is never served to a browser.
        """
        _require_gateway(request)
        found = await asyncio.to_thread(store.published_by_slug, slug)
        if found is None:
            raise OmnigentError("Not found", code=ErrorCode.NOT_FOUND)
        pub, item = found
        data = await asyncio.to_thread(store.read, item)
        from omnigent.db.db_models import current_workspace_id

        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={
                "X-Published-Audience": pub.audience,
                "X-Published-Owner": quote(pub.user_id or ""),
                "X-Published-Workspace": str(current_workspace_id()),
                "X-Published-Version": str(pub.published_version),
                "X-Published-Title": quote((item.title or item.name)[:200]),
                "Cache-Control": "no-store",
            },
        )

    @router.post("/published/{slug}/view")
    async def record_published_view(request: Request, slug: str, body: ViewBody) -> dict[str, Any]:
        """Count one open by an opaque viewer key (gateway-only)."""
        _require_gateway(request)
        counted = await asyncio.to_thread(store.record_view, slug, body.viewer_key)
        return {"counted": counted}

    return router
