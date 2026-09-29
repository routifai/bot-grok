"""Tests for the skills router (``/skills*``, mounted under ``/v1/nova`` in production).

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
from omnigent.nova.skills.routes import create_router

# Offers created via the service directly (there's no route to open one) must
# still clear the gate in ``gate.py`` — see ``test_service.py`` for that gate
# exercised on its own.
_VALID_BODY = (
    "## Steps\n"
    "1. Do the first thing.\n"
    "2. Do the second thing.\n"
    "3. Do the third thing.\n\n"
    "When to use: whenever this task comes up again.\n"
)
_ASKED_REASON = "asked"
_ASKED_MESSAGE = "Please remember how to do this next time."


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


def test_list_skills_empty(client: TestClient) -> None:
    response = client.get("/skills")
    assert response.status_code == 200
    assert response.json() == {"object": "list", "data": []}


def test_get_missing_skill_is_404(client: TestClient) -> None:
    response = client.get("/skills/nope")
    assert response.status_code == 404


def test_delete_missing_skill_is_404(client: TestClient) -> None:
    response = client.delete("/skills/nope")
    assert response.status_code == 404


def test_list_offers_empty(client: TestClient) -> None:
    response = client.get("/skills/offers")
    assert response.status_code == 200
    assert response.json() == {"object": "list", "data": []}


def test_save_missing_offer_is_404(client: TestClient) -> None:
    response = client.post("/skills/offers/deadbeefdeadbeefdeadbeefdeadbeef/save")
    assert response.status_code == 404


def test_dismiss_missing_offer_is_404(client: TestClient) -> None:
    response = client.post("/skills/offers/deadbeefdeadbeefdeadbeefdeadbeef/dismiss")
    assert response.status_code == 404


def test_offer_accept_dismiss_roundtrip_via_service(client: TestClient, db_uri: str) -> None:
    """Exercises accept/dismiss through the routes; offers are created via the
    service directly since there is no route to open one (only tools do)."""
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.skills.service import SkillService
    from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

    service = SkillService(SqlAlchemySkillStore(db_uri))
    actor = NovaActor(user_id="local", workspace_id=0)
    offer = service.offer(
        actor,
        name="Weekly-report",
        description="d",
        body=_VALID_BODY,
        reason=_ASKED_REASON,
        latest_user_message=_ASKED_MESSAGE,
    )

    listed = client.get("/skills/offers")
    assert [o["name"] for o in listed.json()["data"]] == ["Weekly-report"]
    assert listed.json()["data"][0]["offer_kind"] == "new"
    assert listed.json()["data"][0]["target_skill"] is None

    saved = client.post(f"/skills/offers/{offer.id}/save")
    assert saved.status_code == 200
    assert saved.json()["name"] == "Weekly-report"

    fetched = client.get("/skills/Weekly-report")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Weekly-report"

    deleted = client.delete("/skills/Weekly-report")
    assert deleted.status_code == 200
    assert client.get("/skills/Weekly-report").status_code == 404


def test_dismiss_offer_leaves_nothing_saved(client: TestClient, db_uri: str) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.skills.service import SkillService
    from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

    service = SkillService(SqlAlchemySkillStore(db_uri))
    actor = NovaActor(user_id="local", workspace_id=0)
    offer = service.offer(
        actor,
        name="Weekly-report",
        description="d",
        body=_VALID_BODY,
        reason=_ASKED_REASON,
        latest_user_message=_ASKED_MESSAGE,
    )

    response = client.post(f"/skills/offers/{offer.id}/dismiss")
    assert response.status_code == 200
    assert response.json()["status"] == "dismissed"
    assert client.get("/skills/offers").json()["data"] == []
    assert client.get("/skills/Weekly-report").status_code == 404


def test_update_offer_save_replaces_the_target_skills_body(
    client: TestClient, db_uri: str
) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.skills.service import SkillService
    from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

    service = SkillService(SqlAlchemySkillStore(db_uri))
    actor = NovaActor(user_id="local", workspace_id=0)
    service.save(
        actor,
        name="Weekly report",
        description="Summarize the week's engineering progress.",
        body="Old steps.",
    )
    offer = service.offer(
        actor,
        name="Weekly status report",
        description="Summarize the week's engineering progress for the team.",
        body=_VALID_BODY,
        reason=_ASKED_REASON,
        latest_user_message=_ASKED_MESSAGE,
    )

    listed = client.get("/skills/offers").json()["data"]
    assert listed[0]["offer_kind"] == "update"
    assert listed[0]["target_skill"] == "Weekly report"

    saved = client.post(f"/skills/offers/{offer.id}/save")
    assert saved.status_code == 200
    assert saved.json()["name"] == "Weekly report"
    assert "Do the first thing" in saved.json()["content"]
    assert len(client.get("/skills").json()["data"]) == 1
