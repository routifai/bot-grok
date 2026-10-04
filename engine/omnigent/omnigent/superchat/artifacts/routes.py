"""``/v1/artifacts``: deliverable files the Muse saved from its Computer.

``POST`` takes the raw file bytes (the runner-side ``artifact_save`` tool uploads them) and
adds a version when the name already exists in the Conversation. ``GET`` lists the newest
version of each deliverable, returns one with its versions, or streams the content. Owner-scoped:
another owner's rows 404.
"""

from __future__ import annotations

import asyncio
import posixpath
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Query, Request, Response

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.artifacts.store import Artifact, SqlAlchemyArtifactStore
from omnigent.superchat.artifacts.types import KIND_MIME, MAX_ARTIFACT_BYTES, kind_for_name

#: The preview is shown in a sandboxed, origin-less iframe; this keeps a page that is opened
#: directly (or downloaded and served) from reaching anything but public https assets.
_HTML_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; "
    "style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; "
    "media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"
)


def artifact_to_response(item: Artifact, *, versions: int = 1) -> dict[str, Any]:
    """Serialize one artifact version for the REST API."""
    return {
        "id": item.id,
        "artifact_id": item.id,
        "parent_session_id": item.parent_session_id,
        "name": item.name,
        "title": item.title,
        "kind": item.kind,
        "mime": item.mime,
        "size": item.size,
        "version": item.version,
        "versions": versions,
        "published": item.published,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _check_id(value: str, what: str) -> None:
    try:
        uuid_to_bytes(value)
    except InvalidUuidError as exc:
        raise OmnigentError(f"invalid {what}", code=ErrorCode.INVALID_INPUT) from exc


def _disposition(kind: str, name: str) -> str:
    safe = posixpath.basename(name).replace('"', "'") or f"artifact.{kind}"
    return (
        f"filename=\"{safe.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(name)}"
    )


def create_artifacts_router(
    store: SqlAlchemyArtifactStore,
    *,
    conversation_store: ConversationStore,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the artifacts router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str | None:
        user_id = require_user(request, auth_provider)
        owner = user_id if user_id is not None else RESERVED_USER_LOCAL
        return None if owner == RESERVED_USER_LOCAL else owner

    async def _load(request: Request, artifact_id: str) -> Artifact:
        owner = _owner(request)
        _check_id(artifact_id, "artifact id")
        item = await asyncio.to_thread(store.get, artifact_id, user_id=owner)
        if item is None:
            raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
        return item

    @router.post("/artifacts", status_code=201)
    async def create_artifact(
        request: Request,
        parent_session_id: str = Query(),
        name: str = Query(min_length=1, max_length=512),
        title: str | None = Query(default=None, max_length=256),
    ) -> dict[str, Any]:
        """Save the request body as the next version of ``name`` in a session the caller owns."""
        owner = _owner(request)
        _check_id(parent_session_id, "parent_session_id")
        await require_access(
            owner, parent_session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        kind = kind_for_name(name)
        if kind is None:
            raise OmnigentError(
                f"file type not allowed; use one of: {', '.join(KIND_MIME)}",
                code=ErrorCode.INVALID_INPUT,
            )
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_ARTIFACT_BYTES:
            raise OmnigentError("file too large (25 MB max)", code=ErrorCode.INVALID_INPUT)
        data = await request.body()
        if not data:
            raise OmnigentError("file is empty", code=ErrorCode.INVALID_INPUT)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise OmnigentError("file too large (25 MB max)", code=ErrorCode.INVALID_INPUT)
        item = await asyncio.to_thread(
            store.create,
            user_id=owner,
            parent_session_id=parent_session_id,
            name=posixpath.basename(name),
            title=title,
            kind=kind,
            mime=KIND_MIME[kind],
            data=data,
        )
        return artifact_to_response(item, versions=item.version)

    @router.get("/artifacts")
    async def list_artifacts(
        request: Request,
        parent_session_id: str | None = Query(default=None),
        limit: int = Query(default=200, ge=1, le=500),
    ) -> dict[str, Any]:
        """The newest version of each deliverable, newest first."""
        owner = _owner(request)
        if parent_session_id is not None:
            _check_id(parent_session_id, "parent_session_id")
        rows = await asyncio.to_thread(
            store.list_latest, user_id=owner, parent_session_id=parent_session_id, limit=limit
        )
        return {"artifacts": [artifact_to_response(a, versions=n) for a, n in rows]}

    @router.get("/artifacts/{artifact_id}")
    async def get_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """One version's metadata plus every version of its deliverable."""
        item = await _load(request, artifact_id)
        versions = await asyncio.to_thread(store.versions, item)
        return {
            **artifact_to_response(item, versions=len(versions)),
            "all_versions": [
                {"id": v.id, "version": v.version, "size": v.size, "created_at": v.created_at}
                for v in versions
            ],
        }

    @router.get("/artifacts/{artifact_id}/content")
    async def get_artifact_content(
        request: Request,
        artifact_id: str,
        version: int | None = Query(default=None, ge=1),
        download: bool = Query(default=False),
    ) -> Response:
        """The file's bytes with its real content type (``?version=`` picks another version)."""
        item = await _load(request, artifact_id)
        if version is not None and version != item.version:
            match = next(
                (v for v in await asyncio.to_thread(store.versions, item) if v.version == version),
                None,
            )
            if match is None:
                raise OmnigentError("Version not found", code=ErrorCode.NOT_FOUND)
            item = match
        data = await asyncio.to_thread(store.read, item)
        headers = {
            "Content-Disposition": f"{'attachment' if download else 'inline'}; "
            f"{_disposition(item.kind, item.name)}",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=0, must-revalidate",
        }
        if item.kind == "html":
            headers["Content-Security-Policy"] = _HTML_CSP
        return Response(content=data, media_type=item.mime, headers=headers)

    @router.delete("/artifacts/{artifact_id}")
    async def delete_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Delete a deliverable with all its versions."""
        item = await _load(request, artifact_id)
        removed = await asyncio.to_thread(store.delete_group, item)
        return {"deleted": True, "name": item.name, "versions_removed": removed}

    return router
