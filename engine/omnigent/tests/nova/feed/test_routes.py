"""Tests for the feed router (``/feed*``, mounted under ``/v1/nova`` in production).

Builds a minimal standalone FastAPI app around ``create_router`` (no auth
provider, so the caller resolves to Omnigent's single-user ``"local"``),
exercising the routes end to end against a real SQLite ``db_uri``.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaDeps
from omnigent.nova.feed.routes import create_router


@pytest.fixture()
def client(db_uri: str) -> Iterator[TestClient]:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _handle(request: Request, exc: OmnigentError) -> JSONResponse:
        del request
        body = {"error": {"code": exc.code, "message": exc.message}}
        return JSONResponse(status_code=exc.http_status, content=body)

    app.include_router(create_router(NovaDeps(storage_location=db_uri, auth_provider=None)))
    with TestClient(app) as test_client:
        yield test_client


def test_follow_then_list_topics(client: TestClient) -> None:
    response = client.post("/feed/topics", json={"topic": "AI in banking"})
    assert response.status_code == 200
    assert response.json()["topic"] == "AI in banking"

    listed = client.get("/feed/topics")
    assert listed.status_code == 200
    assert [t["topic"] for t in listed.json()["data"]] == ["AI in banking"]


def test_follow_topic_rejects_empty(client: TestClient) -> None:
    response = client.post("/feed/topics", json={"topic": "   "})
    assert response.status_code == 400


def test_unfollow_topic(client: TestClient) -> None:
    followed = client.post("/feed/topics", json={"topic": "AI in banking"}).json()
    response = client.delete(f"/feed/topics/{followed['id']}")
    assert response.status_code == 200
    assert client.get("/feed/topics").json()["data"] == []


def test_unfollow_missing_topic_is_404(client: TestClient) -> None:
    response = client.delete("/feed/topics/deadbeefdeadbeefdeadbeefdeadbeef")
    assert response.status_code == 404


def test_list_feed_empty(client: TestClient) -> None:
    response = client.get("/feed")
    assert response.status_code == 200
    assert response.json() == {"object": "list", "data": [], "next_cursor": None}


def test_list_ideas_empty(client: TestClient) -> None:
    response = client.get("/feed/ideas")
    assert response.status_code == 200
    assert response.json() == {"object": "list", "data": []}
