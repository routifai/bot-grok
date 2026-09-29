"""Tests for the Goals routes (``/v1/nova/goals``) — ownership and shape.

Builds a bare app carrying only the Goals router (the pattern
``tests/server/routes/test_dictation.py`` uses for a router-under-test that
doesn't need the full server), with a tiny header-based
:class:`~omnigent.server.auth.AuthProvider` standing in for real auth. Seeds
data directly through the store (this router has no create endpoint — a Goal
is created via the ``nova_goals`` tool, tested in ``test_tools.py``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.requests import HTTPConnection

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaDeps, new_id
from omnigent.nova.goals.entities import ProposedTask
from omnigent.nova.goals.routes import create_router
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore
from omnigent.server.auth import AuthProvider

ALICE = "alice@example.com"
BOB = "bob@example.com"


class _HeaderAuthProvider(AuthProvider):
    """Trusts an ``X-User`` header — a stand-in for real auth in tests."""

    def get_user_id(self, request: HTTPConnection) -> str | None:
        return request.headers.get("X-User")


def _app(db_uri: str) -> FastAPI:
    app = FastAPI()
    deps = NovaDeps(storage_location=db_uri, auth_provider=_HeaderAuthProvider())
    app.include_router(create_router(deps), prefix="/v1/nova")

    @app.exception_handler(OmnigentError)
    async def _handle_omnigent_error(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"error": {"code": str(exc.code), "message": exc.message}},
        )

    return app


@pytest.fixture()
def app(db_uri: str) -> FastAPI:
    return _app(db_uri)


@pytest_asyncio.fixture()
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _as(user: str) -> dict[str, str]:
    return {"X-User": user}


def _seed_goal(store: SqlAlchemyGoalStore, *, user_id: str = ALICE):
    return store.create(
        new_id(),
        new_id(),
        user_id=user_id,
        title="Learn guitar",
        description="",
        due_date=None,
        check_in_crons=(),
        timezone="UTC",
        tasks=["a", "b"],
    )


async def test_list_requires_auth(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/nova/goals")
    assert resp.status_code == 401


async def test_list_scoped_to_owner(client: httpx.AsyncClient, store: SqlAlchemyGoalStore) -> None:
    _seed_goal(store, user_id=ALICE)
    resp_alice = await client.get("/v1/nova/goals", headers=_as(ALICE))
    assert resp_alice.status_code == 200
    assert len(resp_alice.json()["data"]) == 1

    resp_bob = await client.get("/v1/nova/goals", headers=_as(BOB))
    assert resp_bob.json()["data"] == []


async def test_get_goal_not_found_for_other_owner(
    client: httpx.AsyncClient, store: SqlAlchemyGoalStore
) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    ok = await client.get(f"/v1/nova/goals/{goal.id}", headers=_as(ALICE))
    assert ok.status_code == 200
    assert ok.json()["title"] == "Learn guitar"

    forbidden = await client.get(f"/v1/nova/goals/{goal.id}", headers=_as(BOB))
    assert forbidden.status_code == 404


async def test_patch_updates_status(client: httpx.AsyncClient, store: SqlAlchemyGoalStore) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    resp = await client.patch(
        f"/v1/nova/goals/{goal.id}", json={"status": "paused"}, headers=_as(ALICE)
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "paused"


async def test_patch_rejects_done_status(
    client: httpx.AsyncClient, store: SqlAlchemyGoalStore
) -> None:
    """ "done" reflects the plan's own progress, not a manual PATCH."""
    goal = _seed_goal(store, user_id=ALICE)
    resp = await client.patch(
        f"/v1/nova/goals/{goal.id}", json={"status": "done"}, headers=_as(ALICE)
    )
    assert resp.status_code == 422


async def test_patch_not_found_for_other_owner(
    client: httpx.AsyncClient, store: SqlAlchemyGoalStore
) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    resp = await client.patch(
        f"/v1/nova/goals/{goal.id}", json={"status": "paused"}, headers=_as(BOB)
    )
    assert resp.status_code == 404


async def test_accept_proposal(client: httpx.AsyncClient, store: SqlAlchemyGoalStore) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    proposal_id = goal.open_proposal.id  # type: ignore[union-attr]
    resp = await client.post(f"/v1/nova/goals/proposals/{proposal_id}/accept", headers=_as(ALICE))
    assert resp.status_code == 200
    body = resp.json()
    assert body["open_proposal"] is None
    assert [t["title"] for t in body["tasks"]] == ["a", "b"]


async def test_accept_proposal_conflict_for_other_owner(
    client: httpx.AsyncClient, store: SqlAlchemyGoalStore
) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    proposal_id = goal.open_proposal.id  # type: ignore[union-attr]
    resp = await client.post(f"/v1/nova/goals/proposals/{proposal_id}/accept", headers=_as(BOB))
    assert resp.status_code == 409


async def test_dismiss_proposal(client: httpx.AsyncClient, store: SqlAlchemyGoalStore) -> None:
    goal = _seed_goal(store, user_id=ALICE)
    accepted = store.accept_proposal(goal.open_proposal.id, user_id=ALICE)  # type: ignore[union-attr]
    assert accepted is not None
    revised = store.propose(
        new_id(),
        goal.id,
        user_id=ALICE,
        reason="try something else",
        tasks=[ProposedTask(title="c")],
    )
    assert revised is not None and revised.open_proposal is not None
    resp = await client.post(
        f"/v1/nova/goals/proposals/{revised.open_proposal.id}/dismiss",
        headers=_as(ALICE),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["open_proposal"] is None
    assert [t["title"] for t in body["tasks"]] == [t.title for t in accepted.tasks]
