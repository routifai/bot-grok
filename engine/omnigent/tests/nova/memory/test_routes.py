"""Tests for the memory routes (auth and round trips).

Builds a bare FastAPI app around ``create_router`` directly — these routes
have no dependency on the rest of ``create_app`` — with two auth setups:

- **No auth provider**: ``actor_from_request`` always resolves to the
  reserved ``"local"`` identity (never 401); covers the OSS/local default.
- **Header auth** (``UnifiedAuthProvider(source="header")``): a request
  without the identity header resolves to no actor, covering the 401 path.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest_asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaActor, NovaDeps
from omnigent.nova.memory.entities import NoteKind
from omnigent.nova.memory.routes import create_router
from omnigent.nova.memory.sqlalchemy_store import SqlAlchemyMemoryStore
from omnigent.server.auth import UnifiedAuthProvider

HEADER = "X-Test-User"


def _app(db_uri: str, *, auth_provider: UnifiedAuthProvider | None) -> FastAPI:
    """A bare app around just the memory router — it has no dependency on
    the rest of ``create_app``. Wires the same ``OmnigentError`` -> HTTP
    status mapping ``create_app`` registers globally, minus its audit/log
    side effects (irrelevant to what these tests check)."""
    app = FastAPI()
    app.include_router(
        create_router(NovaDeps(storage_location=db_uri, auth_provider=auth_provider))
    )

    @app.exception_handler(OmnigentError)
    async def _handle_omnigent_error(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(
            status_code=exc.http_status,
            content={"error": {"code": str(exc.code), "message": exc.message}},
        )

    return app


@pytest_asyncio.fixture()
async def client(db_uri: str) -> AsyncIterator[httpx.AsyncClient]:
    """No-auth client: every request resolves to the reserved 'local' user."""
    transport = httpx.ASGITransport(app=_app(db_uri, auth_provider=None))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture()
async def auth_client(db_uri: str) -> AsyncIterator[httpx.AsyncClient]:
    """Header-auth client: a request with no identity header is unauthenticated."""
    provider = UnifiedAuthProvider(source="header", local_single_user=False, header_name=HEADER)
    transport = httpx.ASGITransport(app=_app(db_uri, auth_provider=provider))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ── auth ─────────────────────────────────────────────────────────────────


async def test_list_requires_auth_when_configured(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/memory")
    assert resp.status_code == 401


async def test_list_succeeds_with_identity_header(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.get("/memory", headers={HEADER: "alice@example.com"})
    assert resp.status_code == 200


async def test_list_empty_is_ok_without_auth_provider(client: httpx.AsyncClient) -> None:
    resp = await client.get("/memory")
    assert resp.status_code == 200
    assert resp.json() == {"object": "list", "data": []}


# ── round trip ───────────────────────────────────────────────────────────


async def test_update_replaces_content_and_bumps_revision(
    client: httpx.AsyncClient, db_uri: str
) -> None:
    store = SqlAlchemyMemoryStore(db_uri)
    note = store.save(
        NovaActor(user_id="local", workspace_id=0), NoteKind.ABOUT_YOU, "MEMORY.md", "old"
    )

    resp = await client.put(f"/memory/{note.id}", json={"content": "new"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] == "new"
    assert body["revision"] == 2

    listed = (await client.get("/memory")).json()["data"]
    assert listed[0]["content"] == "new"


async def test_update_missing_note_is_404(client: httpx.AsyncClient) -> None:
    resp = await client.put(f"/memory/{'0' * 32}", json={"content": "x"})
    assert resp.status_code == 404


async def test_export_returns_markdown(client: httpx.AsyncClient, db_uri: str) -> None:
    store = SqlAlchemyMemoryStore(db_uri)
    store.save(
        NovaActor(user_id="local", workspace_id=0), NoteKind.ABOUT_YOU, "MEMORY.md", "Likes tea."
    )

    resp = await client.get("/memory/export")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/markdown")
    assert "# MEMORY.md" in resp.text
    assert "Likes tea." in resp.text


# ── profile ──────────────────────────────────────────────────────────────


async def test_profile_defaults_to_utc(client: httpx.AsyncClient) -> None:
    resp = await client.get("/memory/profile")
    assert resp.status_code == 200
    assert resp.json()["timezone"] == "UTC"


async def test_profile_put_updates_timezone(client: httpx.AsyncClient) -> None:
    resp = await client.put("/memory/profile", json={"timezone": "America/Toronto"})
    assert resp.status_code == 200
    assert resp.json()["timezone"] == "America/Toronto"

    followup = await client.get("/memory/profile")
    assert followup.json()["timezone"] == "America/Toronto"


async def test_profile_put_rejects_invalid_timezone(client: httpx.AsyncClient) -> None:
    resp = await client.put("/memory/profile", json={"timezone": "Not/AZone"})
    assert resp.status_code == 400


async def test_profile_route_not_shadowed_by_note_id_route(client: httpx.AsyncClient) -> None:
    """PUT /memory/profile must hit the profile handler, not PUT /memory/{note_id}."""
    resp = await client.put("/memory/profile", json={"timezone": "UTC"})
    assert resp.status_code == 200
    assert "timezone" in resp.json()
