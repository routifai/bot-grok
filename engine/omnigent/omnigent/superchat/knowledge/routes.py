"""``/v1/sessions/{id}/knowledge``: relays to the index in the person's Computer.

The engine keeps no file, passage or index. Each route asks the Computer's runner (the
``files_*`` handlers, through ``/mcp/execute``) and maps the answer:

* ``status`` and ``thumbnail`` never wake a sleeping Computer: asleep, ``status`` answers the last
  state seen (kept in memory, so it is gone after an engine restart) and ``thumbnail`` answers 404
  unless that page was seen before.
* ``search`` is the person acting: it wakes the Computer the way a message does.
* ``reindex`` only runs on a Computer that is already awake.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any

import httpx
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import LEVEL_READ, AuthProvider
from omnigent.server.routes._auth_helpers import get_user_id as _get_user_id
from omnigent.server.routes._auth_helpers import require_access_and_level as _require_access
from omnigent.stores import ConversationStore
from omnigent.stores.permission_store import PermissionStore
from omnigent.superchat._handler_http import HEX_ID_RE
from omnigent.superchat.artifacts import SqlAlchemyArtifactStore, request_owner

#: How long a search waits for the Computer to wake and its runner to connect.
WAKE_TIMEOUT_S = 120.0
CALL_TIMEOUT_S = 90.0
#: Sessions whose last status is remembered, and thumbnails kept for asleep Computers.
_MAX_SNAPSHOTS = 256
_MAX_THUMBNAILS = 256
_ARTIFACT_LIST_LIMIT = 500


class SearchBody(BaseModel):
    """Body of ``POST /sessions/{id}/knowledge/search``."""

    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=2000)
    file_ids: list[str] | None = Field(default=None, max_length=200)
    k: int = Field(default=8, ge=1, le=25)


class _Remembered:
    """What the relays last saw, per session: the status snapshot and recent thumbnails."""

    def __init__(self) -> None:
        self.status: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.thumbs: OrderedDict[tuple[str, str, int], bytes] = OrderedDict()

    def remember_status(self, session_id: str, status: dict[str, Any]) -> None:
        self.status[session_id] = status
        self.status.move_to_end(session_id)
        while len(self.status) > _MAX_SNAPSHOTS:
            self.status.popitem(last=False)

    def remember_thumb(self, key: tuple[str, str, int], data: bytes) -> None:
        self.thumbs[key] = data
        self.thumbs.move_to_end(key)
        while len(self.thumbs) > _MAX_THUMBNAILS:
            self.thumbs.popitem(last=False)


def _result(payload: Any) -> dict[str, Any]:
    """The tool's JSON output from a runner ``/mcp/execute`` answer, or an engine error."""
    if not isinstance(payload, dict):
        raise OmnigentError("The Computer didn't answer", code=ErrorCode.RUNNER_UNAVAILABLE)
    err = payload.get("error")
    if err:
        message = err.get("message") if isinstance(err, dict) else err
        raise OmnigentError(
            str(message or "The search failed")[:300], code=ErrorCode.INVALID_INPUT
        )
    try:
        output = json.loads(payload["result"]["output"])
    except (KeyError, TypeError, ValueError):
        output = None
    if not isinstance(output, dict):
        raise OmnigentError("The Computer didn't answer", code=ErrorCode.RUNNER_UNAVAILABLE)
    if output.get("error"):
        raise OmnigentError(str(output["error"])[:300], code=ErrorCode.INVALID_INPUT)
    return output


async def _call(client: httpx.AsyncClient, session_id: str, tool: str, args: Mapping[str, Any]):
    try:
        resp = await client.post(
            f"/v1/sessions/{session_id}/mcp/execute",
            json={"method": "tools/call", "params": {"name": tool, "arguments": dict(args)}},
            timeout=CALL_TIMEOUT_S,
        )
        payload = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise OmnigentError(
            "Your Computer didn't answer", code=ErrorCode.RUNNER_UNAVAILABLE
        ) from exc
    return _result(payload)


def create_knowledge_router(
    *,
    conversation_store: ConversationStore,
    artifact_store: SqlAlchemyArtifactStore | None = None,
    runner_router: Any = None,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the router, mounted with ``prefix="/v1"``."""
    router = APIRouter()
    remembered = _Remembered()

    async def _conversation(request: Request, session_id: str, level: int) -> Any:
        user_id = _get_user_id(request, auth_provider)
        await _require_access(
            user_id,
            session_id,
            level,
            permission_store,
            conversation_store,
        )
        conv = await asyncio.to_thread(conversation_store.get_conversation, session_id)
        if conv is None:
            raise OmnigentError("Conversation not found", code=ErrorCode.NOT_FOUND)
        return conv

    async def _awake(session_id: str, conv: Any) -> httpx.AsyncClient | None:
        """The runner's client when it is connected now; never wakes anything."""
        from omnigent.server.routes._sessions.common import get_server_runner_router
        from omnigent.server.routes._sessions.helpers import _get_runner_client

        return await _get_runner_client(
            session_id, runner_router or get_server_runner_router(), conversation=conv
        )

    async def _woken(request: Request, session_id: str, conv: Any) -> httpx.AsyncClient:
        """The runner's client, waking the Computer the way a message does."""
        from omnigent.server.routes._sessions.common import get_server_runner_router
        from omnigent.server.routes._sessions.orchestration import ensure_runner_connected

        unavailable = OmnigentError(
            "Your Computer is still starting; try again shortly",
            code=ErrorCode.RUNNER_UNAVAILABLE,
        )
        try:
            client, _ = await asyncio.wait_for(
                ensure_runner_connected(
                    session_id=session_id,
                    conv=conv,
                    app_state=request.app.state,
                    conversation_store=conversation_store,
                    runner_router=runner_router or get_server_runner_router(),
                ),
                timeout=WAKE_TIMEOUT_S,
            )
        except TimeoutError:
            raise unavailable from None
        if client is None:
            raise unavailable
        return client

    def _with_artifact_ids(request: Request, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Each row without its ``abs_path`` and with the Library ``artifact_id`` of that file."""
        by_path: dict[str, str] = {}
        if artifact_store is not None and rows:
            owner = request_owner(request, auth_provider)
            latest = artifact_store.list_latest(user_id=owner, limit=_ARTIFACT_LIST_LIMIT)
            by_path = {a.source_path: a.id for a, _ in latest if a.source_path}
        return [
            {
                **{k: v for k, v in row.items() if k != "abs_path"},
                "artifact_id": by_path.get(str(row.get("abs_path") or "")),
            }
            for row in rows
        ]

    @router.get("/sessions/{session_id}/knowledge/status")
    async def status(request: Request, session_id: str) -> dict[str, Any]:
        """Per-file index state and whether searches can use embeddings; never wakes."""
        conv = await _conversation(request, session_id, LEVEL_READ)
        client = await _awake(session_id, conv)
        if client is not None:
            try:
                live = await _call(client, session_id, "files_status", {})
            except OmnigentError:
                live = None
            if live is not None:
                files = await asyncio.to_thread(
                    _with_artifact_ids, request, list(live.get("files") or [])
                )
                snapshot = {
                    "files": files,
                    "embeddings": live.get("embeddings") or {"available": False, "reason": None},
                    "updated_at": int(time.time()),
                }
                remembered.remember_status(session_id, snapshot)
                return {**snapshot, "computer": "awake"}
        last = remembered.status.get(session_id)
        if last is None:
            return {
                "files": [],
                "embeddings": {"available": False, "reason": None},
                "computer": "asleep",
                "updated_at": None,
            }
        return {**last, "computer": "asleep"}

    @router.post("/sessions/{session_id}/knowledge/search")
    async def search(request: Request, session_id: str, body: SearchBody) -> dict[str, Any]:
        """Passages from the person's files, best first; wakes the Computer."""
        for file_id in body.file_ids or []:
            if not HEX_ID_RE.match(file_id):
                raise OmnigentError("invalid file id", code=ErrorCode.INVALID_INPUT)
        conv = await _conversation(request, session_id, LEVEL_READ)
        client = await _woken(request, session_id, conv)
        found = await _call(
            client,
            session_id,
            "files_search",
            {"query": body.query, "file_ids": body.file_ids, "k": body.k},
        )
        found.pop("type", None)
        results = await asyncio.to_thread(
            _with_artifact_ids, request, list(found.get("results") or [])
        )
        return {**found, "results": results}

    @router.get("/sessions/{session_id}/knowledge/files/{file_id}/pages/{page}/thumbnail")
    async def thumbnail(request: Request, session_id: str, file_id: str, page: int) -> Response:
        """A page's 256 px WebP; 404 when the Computer is asleep and it wasn't seen before."""
        if not HEX_ID_RE.match(file_id):
            raise OmnigentError("invalid file id", code=ErrorCode.INVALID_INPUT)
        conv = await _conversation(request, session_id, LEVEL_READ)
        key = (session_id, file_id, page)
        data = remembered.thumbs.get(key)
        if data is None:
            client = await _awake(session_id, conv)
            if client is not None:
                try:
                    found = await _call(
                        client, session_id, "files_thumbnail", {"file_id": file_id, "page": page}
                    )
                    data = base64.b64decode(found.get("image_base64") or "")
                except (OmnigentError, ValueError):
                    data = None
        if not data:
            raise OmnigentError("Page image not found", code=ErrorCode.NOT_FOUND)
        remembered.remember_thumb(key, data)
        return Response(
            content=data,
            media_type="image/webp",
            headers={
                "Cache-Control": "private, max-age=3600",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post("/sessions/{session_id}/knowledge/reindex")
    async def reindex(request: Request, session_id: str) -> dict[str, Any]:
        """Re-embed files indexed without embeddings; does nothing while the Computer sleeps."""
        conv = await _conversation(request, session_id, LEVEL_READ)
        client = await _awake(session_id, conv)
        if client is None:
            return {"queued": 0}
        try:
            found = await _call(client, session_id, "files_reindex", {})
        except OmnigentError:
            return {"queued": 0}
        return {"queued": int(found.get("queued") or 0)}

    return router
