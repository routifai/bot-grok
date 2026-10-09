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
from omnigent.superchat.artifact_kinds import KIND_MIME, MAX_ARTIFACT_BYTES, kind_for_name
from omnigent.superchat.artifacts.store import (
    Artifact,
    Publication,
    SqlAlchemyArtifactStore,
    ViewStats,
)

#: The preview is shown in a sandboxed, origin-less iframe; this keeps a page that is opened
#: directly (or downloaded and served) from reaching anything but public https assets.
_HTML_CSP = (
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; "
    "style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; "
    "media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"
)


def publication_to_response(pub: Publication, stats: ViewStats | None = None) -> dict[str, Any]:
    """Serialize a publication with its view stats."""
    return {
        "slug": pub.slug,
        "url_path": pub.url_path,
        "audience": pub.audience,
        "version": pub.published_version,
        "published_at": pub.published_at,
        "updated_at": pub.updated_at,
        "stats": (stats or ViewStats()).as_dict(),
    }


def artifact_to_response(
    item: Artifact,
    *,
    versions: int = 1,
    publication: Publication | None = None,
    stats: ViewStats | None = None,
) -> dict[str, Any]:
    """Serialize one artifact version for the REST API."""
    return {
        "publish": publication_to_response(publication, stats) if publication else None,
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
        "published": publication is not None,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "origin": item.origin,
        "parent_version_id": item.parent_version_id,
        "edit_summary": item.edit_summary,
    }


def check_id(value: str, what: str) -> None:
    try:
        uuid_to_bytes(value)
    except InvalidUuidError as exc:
        raise OmnigentError(f"invalid {what}", code=ErrorCode.INVALID_INPUT) from exc


def _disposition(kind: str, name: str) -> str:
    safe = posixpath.basename(name).replace('"', "'") or f"artifact.{kind}"
    return (
        f"filename=\"{safe.encode('ascii', 'replace').decode()}\"; filename*=UTF-8''{quote(name)}"
    )


def request_owner(request: Request, auth_provider: AuthProvider | None) -> str | None:
    """The calling owner's id, or ``None`` for the single local user (rows are unowned)."""
    user_id = require_user(request, auth_provider)
    owner = user_id if user_id is not None else RESERVED_USER_LOCAL
    return None if owner == RESERVED_USER_LOCAL else owner


async def load_artifact(
    store: SqlAlchemyArtifactStore, owner: str | None, artifact_id: str
) -> Artifact:
    """The owner's artifact version, or a 404 (another owner's rows are indistinguishable)."""
    check_id(artifact_id, "artifact id")
    item = await asyncio.to_thread(store.get, artifact_id, user_id=owner)
    if item is None:
        raise OmnigentError("Artifact not found", code=ErrorCode.NOT_FOUND)
    return item


def _refuse_unseen_manual_edit(
    store: SqlAlchemyArtifactStore, owner: str | None, session_id: str, name: str
) -> None:
    """409 when the newest version is a hand edit the Muse has not been told about yet.

    A save built from an older copy of the file would silently overwrite the person's edit; the
    write-back at the start of the Muse's turn marks the edit delivered, so a Muse that re-read
    the file passes.
    """
    group = store.versions_of(user_id=owner, parent_session_id=session_id, name=name)
    head = group[0] if group else None
    if head is not None and head.origin == "manual" and head.delivered_at is None:
        raise OmnigentError(
            f"The person edited {name} by hand (v{head.version}); read the workspace file "
            "again and apply your change on top of their edits before saving.",
            code=ErrorCode.CONFLICT,
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
        return request_owner(request, auth_provider)

    async def _load(request: Request, artifact_id: str) -> Artifact:
        return await load_artifact(store, _owner(request), artifact_id)

    @router.post("/artifacts", status_code=201)
    async def create_artifact(
        request: Request,
        parent_session_id: str = Query(),
        name: str = Query(min_length=1, max_length=512),
        title: str | None = Query(default=None, max_length=256),
        source_path: str | None = Query(default=None, max_length=1024),
    ) -> dict[str, Any]:
        """Save the request body as the next version of ``name`` in a session the caller owns."""
        owner = _owner(request)
        check_id(parent_session_id, "parent_session_id")
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
        clean_name = posixpath.basename(name)
        await asyncio.to_thread(
            _refuse_unseen_manual_edit, store, owner, parent_session_id, clean_name
        )
        item = await asyncio.to_thread(
            store.create,
            user_id=owner,
            parent_session_id=parent_session_id,
            name=clean_name,
            title=title,
            kind=kind,
            mime=KIND_MIME[kind],
            data=data,
            source_path=source_path,
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
            check_id(parent_session_id, "parent_session_id")
        rows = await asyncio.to_thread(
            store.list_latest, user_id=owner, parent_session_id=parent_session_id, limit=limit
        )
        pubs = await asyncio.to_thread(store.publications_for_owner, owner)
        stats = await asyncio.to_thread(store.stats, [p.slug for p in pubs.values()])
        out = []
        for a, n in rows:
            pub = pubs.get((a.parent_session_id, a.name))
            out.append(
                artifact_to_response(
                    a, versions=n, publication=pub, stats=stats.get(pub.slug) if pub else None
                )
            )
        return {"artifacts": out}

    @router.get("/artifacts/pending-edits")
    async def pending_edits(request: Request, parent_session_id: str = Query()) -> dict[str, Any]:
        """Hand-edited versions in a session not yet written back to its Computer.

        The runner calls this at the start of the Muse's turn: it writes each ``latest``
        edit's bytes to ``source_path``, tells the Muse (``note``) and then acks the ids via
        ``POST /artifacts/{id}/delivered``.
        """
        owner = _owner(request)
        check_id(parent_session_id, "parent_session_id")
        await require_access(
            owner, parent_session_id, LEVEL_OWNER, permission_store, conversation_store
        )
        rows = await asyncio.to_thread(
            store.pending_manual, user_id=owner, parent_session_id=parent_session_id
        )
        newest: dict[str, int] = {}
        for row in rows:
            newest[row.name] = max(newest.get(row.name, 0), row.version)
        edits = []
        for row in rows:
            head = await asyncio.to_thread(store.newest, row)
            edits.append(
                {
                    **artifact_to_response(row),
                    "source_path": row.source_path,
                    # Only the group's newest version is written back, and only when it is
                    # this hand edit (a later save by the Muse supersedes it).
                    "write_back": head is not None and head.id == row.id,
                }
            )
        return {"edits": edits}

    @router.post("/artifacts/{artifact_id}/delivered")
    async def mark_delivered(request: Request, artifact_id: str) -> dict[str, Any]:
        """Ack that a hand-edited version was written back and announced (idempotent)."""
        item = await _load(request, artifact_id)
        ok = await asyncio.to_thread(store.mark_delivered, item.id, user_id=item.user_id)
        return {"delivered": ok}

    @router.get("/artifacts/{artifact_id}")
    async def get_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """One version's metadata plus every version of its deliverable."""
        item = await _load(request, artifact_id)
        versions = await asyncio.to_thread(store.versions, item)
        pub = await asyncio.to_thread(store.publication_for, item)
        stats = (await asyncio.to_thread(store.stats, [pub.slug])).get(pub.slug) if pub else None
        return {
            **artifact_to_response(item, versions=len(versions), publication=pub, stats=stats),
            "all_versions": [
                {
                    "id": v.id,
                    "version": v.version,
                    "size": v.size,
                    "created_at": v.created_at,
                    "origin": v.origin,
                    "parent_version_id": v.parent_version_id,
                    "edit_summary": v.edit_summary,
                }
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
