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
from pydantic import BaseModel, Field

from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_OWNER, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access, require_user
from omnigent.stores import ConversationStore, PermissionStore
from omnigent.superchat.artifacts import table as tbl
from omnigent.superchat.artifacts.store import (
    Artifact,
    SqlAlchemyArtifactStore,
    VersionConflictError,
)
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
        "origin": item.origin,
        "parent_version_id": item.parent_version_id,
        "edit_summary": item.edit_summary,
    }


class TableCellEdit(BaseModel):
    """One cell change; ``row`` / ``col`` are 0-based, row 0 is the first displayed row."""

    sheet: str = Field(max_length=256)
    row: int = Field(ge=0, lt=1_048_576)
    col: int = Field(ge=0, lt=16_384)
    value: str | int | float | bool | None = None


class TableEditBody(BaseModel):
    """``PATCH /artifacts/{id}/table`` body."""

    base_version: int = Field(ge=1)
    edits: list[TableCellEdit] = Field(min_length=1, max_length=500)


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
        source_path: str | None = Query(default=None, max_length=1024),
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
            _check_id(parent_session_id, "parent_session_id")
        rows = await asyncio.to_thread(
            store.list_latest, user_id=owner, parent_session_id=parent_session_id, limit=limit
        )
        return {"artifacts": [artifact_to_response(a, versions=n) for a, n in rows]}

    @router.get("/artifacts/pending-edits")
    async def pending_edits(request: Request, parent_session_id: str = Query()) -> dict[str, Any]:
        """Hand-edited versions in a session not yet written back to its Computer.

        The runner calls this at the start of the Muse's turn: it writes each ``latest``
        edit's bytes to ``source_path``, tells the Muse (``note``) and then acks the ids via
        ``POST /artifacts/{id}/delivered``.
        """
        owner = _owner(request)
        _check_id(parent_session_id, "parent_session_id")
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
        return {
            **artifact_to_response(item, versions=len(versions)),
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

    async def _table_item(request: Request, artifact_id: str) -> Artifact:
        item = await _load(request, artifact_id)
        if item.kind not in tbl.TABLE_KINDS:
            raise OmnigentError("not a spreadsheet or CSV file", code=ErrorCode.INVALID_INPUT)
        return item

    async def _sheets(item: Artifact) -> list[dict[str, Any]]:
        data = await asyncio.to_thread(store.read, item)
        try:
            return await asyncio.to_thread(tbl.read_table, data, item.kind)
        except tbl.TableError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc

    @router.get("/artifacts/{artifact_id}/table")
    async def get_table(request: Request, artifact_id: str) -> dict[str, Any]:
        """The CSV / XLSX as grids: ``sheets[].rows[][] = {v, f, t}`` (see ``truncated``)."""
        item = await _table_item(request, artifact_id)
        return {
            "artifact_id": item.id,
            "version": item.version,
            "kind": item.kind,
            "sheets": await _sheets(item),
        }

    @router.get("/artifacts/{artifact_id}/table/range")
    async def get_table_range(
        request: Request,
        artifact_id: str,
        range: str = Query(max_length=64),
        sheet: str | None = Query(default=None, max_length=256),
    ) -> dict[str, Any]:
        """A fenced, untrusted-data excerpt of a selection for the person's next message."""
        item = await _table_item(request, artifact_id)
        sheets = await _sheets(item)
        try:
            block = tbl.range_block(
                sheets, name=item.name, version=item.version, sheet=sheet, range_text=range
            )
        except tbl.TableError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
        return {"artifact_id": item.id, "version": item.version, "block": block}

    @router.patch("/artifacts/{artifact_id}/table")
    async def edit_table(
        request: Request, artifact_id: str, body: TableEditBody
    ) -> dict[str, Any]:
        """Apply cell edits as a NEW ``manual`` version; 409 when ``base_version`` is stale."""
        item = await _table_item(request, artifact_id)
        newest = await asyncio.to_thread(store.newest, item)
        head = newest.version if newest else item.version
        if body.base_version != head or item.version != head:
            raise OmnigentError(
                f"Stale edit: the newest version is {head}, not {body.base_version}",
                code=ErrorCode.CONFLICT,
            )
        data = await asyncio.to_thread(store.read, item)
        edits = [tbl.CellEdit(e.sheet, e.row, e.col, e.value) for e in body.edits]
        try:
            new_data, summary = await asyncio.to_thread(tbl.apply_edits, data, item.kind, edits)
        except tbl.TableError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from exc
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
                edit_summary=summary,
                base_version=body.base_version,
            )
        except VersionConflictError as exc:
            raise OmnigentError(
                f"Stale edit: the newest version is {exc.newest}, not {body.base_version}",
                code=ErrorCode.CONFLICT,
            ) from exc
        return artifact_to_response(created, versions=created.version)

    @router.delete("/artifacts/{artifact_id}")
    async def delete_artifact(request: Request, artifact_id: str) -> dict[str, Any]:
        """Delete a deliverable with all its versions."""
        item = await _load(request, artifact_id)
        removed = await asyncio.to_thread(store.delete_group, item)
        return {"deleted": True, "name": item.name, "versions_removed": removed}

    return router
