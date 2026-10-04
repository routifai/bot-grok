"""Route tests for parent-bound scheduled tasks and ``/v1/me/proactivity``."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.server.routes.scheduled_tasks import create_scheduled_tasks_router
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore

_AGENT = uuid.uuid4().hex
_PARENT = uuid.uuid4().hex
_RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"


@dataclass
class _Agent:
    id: str = _AGENT
    session_id: str | None = None
    bundle_location: str | None = None


@dataclass
class _Conv:
    id: str
    agent_id: str | None = _AGENT


class _AgentStore:
    def get(self, agent_id: str) -> _Agent | None:
        return _Agent() if agent_id == _AGENT else None


class _ConvStore:
    def get_conversation(self, conversation_id: str) -> _Conv | None:
        return _Conv(_PARENT) if conversation_id == _PARENT else None


@pytest.fixture()
def client(db_uri: str) -> TestClient:
    store = SqlAlchemyScheduledTaskStore(db_uri)
    app = FastAPI()
    app.include_router(
        create_scheduled_tasks_router(
            store, agent_store=_AgentStore(), conversation_store=_ConvStore()
        ),
        prefix="/v1",
    )
    return TestClient(app)


def _body(**extra: Any) -> dict[str, Any]:
    return {"name": "feed", "prompt": "check", "rrule": _RRULE, **extra}


def test_create_bound_task_defaults_agent_to_parents(client: TestClient) -> None:
    resp = client.post(
        "/v1/scheduled-tasks",
        json=_body(
            parent_session_id=_PARENT, agent_type="researcher", execution_target="connected_host"
        ),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert (data["parent_session_id"], data["agent_type"], data["agent_id"]) == (
        _PARENT,
        "researcher",
        _AGENT,
    )


def test_list_filters_by_parent(client: TestClient) -> None:
    client.post(
        "/v1/scheduled-tasks", json=_body(parent_session_id=_PARENT, agent_type="researcher")
    )
    client.post("/v1/scheduled-tasks", json=_body(agent_id=_AGENT))
    everything = client.get("/v1/scheduled-tasks").json()["scheduled_tasks"]
    bound = client.get(f"/v1/scheduled-tasks?parent_session_id={_PARENT}").json()[
        "scheduled_tasks"
    ]
    assert len(everything) == 2 and len(bound) == 1
    assert client.get("/v1/scheduled-tasks?parent_session_id=other").json() == {
        "scheduled_tasks": []
    }


def test_binding_requires_agent_type_and_agent_without_parent(client: TestClient) -> None:
    assert (
        client.post("/v1/scheduled-tasks", json=_body(parent_session_id=_PARENT)).status_code
        == 422
    )
    assert client.post("/v1/scheduled-tasks", json=_body()).status_code == 422
    assert (
        client.post("/v1/scheduled-tasks", json=_body(agent_id=_AGENT, agent_type="x")).status_code
        == 422
    )


def test_unknown_parent_is_rejected(client: TestClient) -> None:
    with pytest.raises(OmnigentError):
        client.post(
            "/v1/scheduled-tasks",
            json=_body(parent_session_id=uuid.uuid4().hex, agent_type="researcher"),
        )


def test_patch_can_unbind(client: TestClient) -> None:
    created = client.post(
        "/v1/scheduled-tasks", json=_body(parent_session_id=_PARENT, agent_type="researcher")
    ).json()
    resp = client.patch(
        f"/v1/scheduled-tasks/{created['id']}",
        json={"parent_session_id": None, "agent_type": None},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["parent_session_id"] is None


def test_runs_expose_conversation_and_attempt(client: TestClient, db_uri: str) -> None:
    created = client.post(
        "/v1/scheduled-tasks", json=_body(parent_session_id=_PARENT, agent_type="researcher")
    ).json()
    SqlAlchemyScheduledTaskStore(db_uri).create_run(
        uuid.uuid4().hex,
        created["id"],
        "succeeded",
        100,
        conversation_id=uuid.uuid4().hex,
        attempt=2,
    )
    run = client.get(f"/v1/scheduled-tasks/{created['id']}/runs").json()["runs"][0]
    assert run["conversation_id"] and run["attempt"] == 2


def test_proactivity_defaults_and_roundtrip(client: TestClient) -> None:
    assert client.get("/v1/me/proactivity").json() == {
        "proactivity": "normal",
        "quiet_start": None,
        "quiet_end": None,
        "timezone": "UTC",
    }
    body = {
        "proactivity": "low",
        "quiet_start": "22:00",
        "quiet_end": "07:00",
        "timezone": "America/Toronto",
    }
    assert client.put("/v1/me/proactivity", json=body).json() == body
    assert client.get("/v1/me/proactivity").json() == body


@pytest.mark.parametrize(
    "bad",
    [
        {"proactivity": "loud"},
        {"quiet_start": "25:00", "quiet_end": "07:00"},
        {"quiet_start": "22:00"},
    ],
)
def test_proactivity_rejects_invalid(client: TestClient, bad: dict[str, Any]) -> None:
    assert client.put("/v1/me/proactivity", json=bad).status_code == 422


def test_proactivity_put_is_partial(client: TestClient) -> None:
    full = {
        "proactivity": "low",
        "quiet_start": "22:00",
        "quiet_end": "07:00",
        "timezone": "UTC",
    }
    client.put("/v1/me/proactivity", json=full)
    out = client.put("/v1/me/proactivity", json={"timezone": "America/Toronto"}).json()
    assert out == {**full, "timezone": "America/Toronto"}
    with pytest.raises(OmnigentError):
        client.put("/v1/me/proactivity", json={"timezone": "Nope/Zone"})


def test_scheduled_task_timezone_defaults_to_owner_preference(client: TestClient) -> None:
    agent = {"agent_id": _AGENT}
    assert client.post("/v1/scheduled-tasks", json=_body(**agent)).json()["timezone"] == "UTC"
    client.put("/v1/me/proactivity", json={"timezone": "America/Toronto"})
    created = client.post("/v1/scheduled-tasks", json=_body(**agent)).json()
    assert created["timezone"] == "America/Toronto"
    explicit = client.post("/v1/scheduled-tasks", json=_body(timezone="Europe/Paris", **agent))
    assert explicit.json()["timezone"] == "Europe/Paris"
