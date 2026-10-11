"""The single local user saves artifacts and reads pending edits in its own sessions."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.server.auth import RESERVED_USER_LOCAL
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.superchat.artifacts import routes as artifact_routes
from omnigent.superchat.artifacts.routes import create_artifacts_router
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore

_SESSION = uuid.uuid4().hex


class _LocalAuth:
    """Header auth on a single-user runtime: a request with no identity header is "local"."""

    def get_user_id(self, request: Request) -> str | None:
        return RESERVED_USER_LOCAL


class _Convs:
    pass


@pytest.fixture()
def env(db_uri: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    checked: list[Any] = []

    async def _require_access(user_id: str | None, *_args: Any, **_kwargs: Any) -> None:
        # The real check refuses ``None`` as unauthenticated whenever permissions are on.
        checked.append(user_id)
        if user_id is None:
            raise OmnigentError("Authentication required", code=ErrorCode.UNAUTHORIZED)

    monkeypatch.setattr(artifact_routes, "require_access", _require_access)
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    store = SqlAlchemyArtifactStore(db_uri, lambda: blobs)
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.http_status)

    app.include_router(
        create_artifacts_router(
            store,
            conversation_store=_Convs(),  # type: ignore[arg-type]
            auth_provider=_LocalAuth(),  # type: ignore[arg-type]
            permission_store=object(),  # type: ignore[arg-type]
        ),
        prefix="/v1",
    )
    return checked, TestClient(app)


def test_local_user_saves_an_artifact_and_reads_pending_edits(env) -> None:
    checked, client = env
    saved = client.post(
        f"/v1/artifacts?parent_session_id={_SESSION}&name=tea.deck.html",
        content=b"<html><body>tea</body></html>",
        headers={"content-type": "text/html"},
    )
    assert saved.status_code == 201, saved.text
    pending = client.get(f"/v1/artifacts/pending-edits?parent_session_id={_SESSION}")
    assert pending.status_code == 200, pending.text
    assert pending.json() == {"edits": []}
    assert checked == [RESERVED_USER_LOCAL, RESERVED_USER_LOCAL]
