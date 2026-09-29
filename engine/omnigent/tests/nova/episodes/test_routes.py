"""Tests for the episodes routes (``/v1/nova/episodes``).

Mounts ``create_router`` on a bare FastAPI app (not the full server), with a
minimal header-based auth provider standing in for the real one, so ownership
across two callers can be exercised directly.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaActor, NovaDeps
from omnigent.nova.episodes.routes import create_router
from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore
from omnigent.server.auth import AuthProvider

ALICE = "alice@example.com"
BOB = "bob@example.com"


class _HeaderAuthProvider(AuthProvider):
    """Trusts an ``X-User`` header — enough to exercise ownership scoping."""

    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("X-User")


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyEpisodeStore:
    return SqlAlchemyEpisodeStore(db_uri)


@pytest.fixture()
def app(db_uri: str) -> FastAPI:
    deps = NovaDeps(storage_location=db_uri, auth_provider=_HeaderAuthProvider())
    fastapi_app = FastAPI()
    fastapi_app.include_router(create_router(deps), prefix="/v1/nova")

    # The real server's app.py registers a global OmnigentError -> JSON
    # handler; this bare test app needs the same minimal translation.
    @fastapi_app.exception_handler(OmnigentError)
    async def _handle_omnigent_error(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(status_code=exc.http_status, content={"error": exc.message})

    return fastapi_app


@pytest_asyncio.fixture()
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _as_user(user: str) -> dict[str, str]:
    return {"X-User": user}


def _seed(store: SqlAlchemyEpisodeStore, user_id: str, *, title: str, turn_id: str) -> str:
    # A distinct session id per owner: a session (and so its turns) has
    # exactly one owner in practice.
    episode = store.upsert(
        actor=NovaActor(user_id=user_id, workspace_id=0),
        session_id=f"conv_{user_id}",
        turn_id=turn_id,
        title=title,
        summary="Summary",
        tools=("web_search",),
        links=(),
        created_at=1_700_000_000,
    )
    return episode.id


@pytest.mark.asyncio
async def test_list_requires_authentication(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/nova/episodes")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_list_returns_the_callers_episodes(
    client: httpx.AsyncClient, store: SqlAlchemyEpisodeStore
) -> None:
    _seed(store, ALICE, title="Alice's episode", turn_id="resp_1")
    _seed(store, BOB, title="Bob's episode", turn_id="resp_1")

    response = await client.get("/v1/nova/episodes", headers=_as_user(ALICE))

    assert response.status_code == 200
    body = response.json()
    assert [e["title"] for e in body["data"]] == ["Alice's episode"]


@pytest.mark.asyncio
async def test_list_respects_limit(
    client: httpx.AsyncClient, store: SqlAlchemyEpisodeStore
) -> None:
    for i in range(5):
        _seed(store, ALICE, title=f"Episode {i}", turn_id=f"resp_{i}")

    response = await client.get("/v1/nova/episodes", params={"limit": 2}, headers=_as_user(ALICE))

    assert response.status_code == 200
    assert len(response.json()["data"]) == 2


@pytest.mark.asyncio
async def test_delete_requires_authentication(client: httpx.AsyncClient) -> None:
    response = await client.delete("/v1/nova/episodes/some_id")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_delete_removes_the_callers_episode(
    client: httpx.AsyncClient, store: SqlAlchemyEpisodeStore
) -> None:
    episode_id = _seed(store, ALICE, title="Alice's episode", turn_id="resp_1")

    response = await client.delete(f"/v1/nova/episodes/{episode_id}", headers=_as_user(ALICE))

    assert response.status_code == 200
    assert response.json() == {"id": episode_id, "object": "nova.episode.deleted", "deleted": True}
    assert store.list_recent(actor=NovaActor(user_id=ALICE, workspace_id=0), limit=10) == []


@pytest.mark.asyncio
async def test_delete_cannot_remove_someone_elses_episode(
    client: httpx.AsyncClient, store: SqlAlchemyEpisodeStore
) -> None:
    episode_id = _seed(store, ALICE, title="Alice's episode", turn_id="resp_1")

    response = await client.delete(f"/v1/nova/episodes/{episode_id}", headers=_as_user(BOB))

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_missing_is_404(client: httpx.AsyncClient) -> None:
    response = await client.delete("/v1/nova/episodes/" + "0" * 32, headers=_as_user(ALICE))
    assert response.status_code == 404
