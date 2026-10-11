"""``PATCH /v1/artifacts/{id}/edit``: hand edits of an HTML file, saved as a ``manual`` version.

A deck or any HTML page or mini app takes the same patches (``decks/patches.py``; a page has no
slides and no theme, so ``set-theme`` is refused for it). The engine applies them to the version
it names and stores the result as a new version tagged ``manual``. A stale ``base_version`` is an
``artifact_stale`` 409 the editor reloads from; a patch that cannot be applied exactly is a
``conflict`` 409 whose message says to ask Superchat instead. The write-back to the Computer and
the "you changed X" note are the artifacts capability's turn prefix.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import AuthProvider
from omnigent.superchat.artifact_kinds import MAX_ARTIFACT_BYTES
from omnigent.superchat.artifacts.routes import artifact_to_response, load_artifact, request_owner
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore, VersionConflictError
from omnigent.superchat.decks.names import is_deck_name
from omnigent.superchat.decks.patches import (
    MAX_PATCHES,
    AmbiguousEdit,
    InvalidPatch,
    Patch,
    apply_patches,
)

#: Sent with ``ErrorCode.ARTIFACT_STALE``; the web keys off the code, never this text.
STALE_MESSAGE = "The file changed since you opened it, so the latest version is showing now."


class HtmlEditBody(BaseModel):
    """``PATCH /artifacts/{id}/edit`` body."""

    base_version: int = Field(ge=1)
    patches: list[Patch] = Field(min_length=1, max_length=MAX_PATCHES)


def create_html_edit_router(
    store: SqlAlchemyArtifactStore, *, auth_provider: AuthProvider | None = None
) -> APIRouter:
    """Build the HTML edit router (decks, pages), mounted at ``/v1`` after the artifacts one."""
    router = APIRouter()

    @router.patch("/artifacts/{artifact_id}/edit")
    async def edit_html(request: Request, artifact_id: str, body: HtmlEditBody) -> dict[str, Any]:
        """Apply patches as a NEW ``manual`` version; 409 when ``base_version`` is stale."""
        item = await load_artifact(store, request_owner(request, auth_provider), artifact_id)
        deck = is_deck_name(item.name)
        if not deck and item.kind != "html":
            raise OmnigentError("That file can't be edited by hand", code=ErrorCode.INVALID_INPUT)
        if not deck and any(p.kind == "set-theme" for p in body.patches):
            raise OmnigentError("Only a deck has a theme", code=ErrorCode.INVALID_INPUT)
        newest = await asyncio.to_thread(store.newest, item)
        head = newest.version if newest else item.version
        if body.base_version != head or item.version != head:
            raise OmnigentError(STALE_MESSAGE, code=ErrorCode.ARTIFACT_STALE)
        data = await asyncio.to_thread(store.read, item)
        try:
            new_data, summary = await asyncio.to_thread(apply_patches, data, body.patches)
        except InvalidPatch as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
        except AmbiguousEdit as exc:
            raise OmnigentError(str(exc), code=ErrorCode.CONFLICT) from exc
        if new_data == data:  # nothing changed: no identical "edited by hand" version
            return artifact_to_response(item, versions=item.version)
        if len(new_data) > MAX_ARTIFACT_BYTES:
            raise OmnigentError("file too large (25 MB max)", code=ErrorCode.INVALID_INPUT)
        try:
            created = await asyncio.to_thread(
                store.create,
                user_id=item.user_id,
                parent_session_id=item.parent_session_id,
                name=item.name,
                title=item.title,
                kind=item.kind,
                mime=item.mime,
                data=new_data,
                origin="manual",
                parent_version_id=item.id,
                source_path=item.source_path,
                edit_summary=summary or "edited by hand",
                base_version=body.base_version,
            )
        except VersionConflictError as exc:
            raise OmnigentError(STALE_MESSAGE, code=ErrorCode.ARTIFACT_STALE) from exc
        return artifact_to_response(created, versions=created.version)

    return router
