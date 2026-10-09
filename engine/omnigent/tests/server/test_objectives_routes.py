"""Route tests for ``/v1/objectives``."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.stores.objective_store.sqlalchemy_store import SqlAlchemyObjectiveStore
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore
from omnigent.superchat.goals.routes import create_objectives_router

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

    def list_latest_message_items_for_conversations(self, ids: list[str], n: int) -> dict:
        return {}


def _app(db_uri: str, header_user: str | None = None) -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_objectives_router(
            SqlAlchemyObjectiveStore(db_uri),
            scheduled_task_store=SqlAlchemyScheduledTaskStore(db_uri),
            agent_store=_AgentStore(),
            conversation_store=_ConvStore(),
        ),
        prefix="/v1",
    )
    return app


@pytest.fixture()
def client(db_uri: str) -> TestClient:
    return TestClient(_app(db_uri))


def _raises(code: ErrorCode):
    """Bare test app has no error handler: the OmnigentError propagates."""
    return _Code(code)


class _Code:
    def __init__(self, code: ErrorCode) -> None:
        self.code = code

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        assert exc_type is OmnigentError and exc.code == self.code, exc
        return True


def _create(client: TestClient, **extra: Any) -> dict[str, Any]:
    body = {
        "parent_session_id": _PARENT,
        "title": "Audit prep",
        "description": "ready by March",
        "plan": [{"title": "a"}, {"title": "b"}],
        "rrule": _RRULE,
        **extra,
    }
    resp = client.post("/v1/objectives", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_create_makes_objective_first_proposal_and_goal_task(
    client: TestClient, db_uri: str
) -> None:
    obj = _create(client)
    assert obj["status"] == "active" and obj["plan"] == []
    assert [i["title"] for i in obj["open_proposal"]["plan"]] == ["a", "b"]
    task = SqlAlchemyScheduledTaskStore(db_uri).get(obj["scheduled_task_id"])
    assert task is not None
    assert (task.parent_session_id, task.agent_type) == (_PARENT, "goal")
    assert obj["id"] in task.prompt
    listed = client.get(f"/v1/objectives?parent_session_id={_PARENT}").json()["objectives"]
    assert [o["id"] for o in listed] == [obj["id"]]
    assert client.get("/v1/objectives?parent_session_id=nope").json() == {"objectives": []}


def test_create_without_cadence_has_no_task(client: TestClient) -> None:
    obj = client.post("/v1/objectives", json={"parent_session_id": _PARENT, "title": "t"}).json()
    assert obj["scheduled_task_id"] is None and obj["open_proposal"] is None


def test_create_rejects_unknown_parent(client: TestClient) -> None:
    with pytest.raises(OmnigentError):
        client.post(
            "/v1/objectives",
            json={"parent_session_id": uuid.uuid4().hex, "title": "t", "rrule": _RRULE},
        )


def test_accept_applies_plan_atomically_and_keeps_ids(client: TestClient) -> None:
    obj = _create(client)
    prop = obj["open_proposal"]
    resp = client.post(f"/v1/objectives/{obj['id']}/proposals/{prop['id']}/accept")
    assert resp.status_code == 200, resp.text
    plan = resp.json()["plan"]
    assert [t["title"] for t in plan] == ["a", "b"] and resp.json()["open_proposal"] is None
    done = client.patch(
        f"/v1/objectives/{obj['id']}/tasks/{plan[0]['id']}",
        json={"status": "done", "note": "ok"},
    )
    assert done.json()["status"] == "done"
    revised = client.post(
        f"/v1/objectives/{obj['id']}/proposals",
        json={"reason": "add c", "plan": [{"id": plan[0]["id"], "title": "a"}, {"title": "c"}]},
    ).json()
    out = client.post(f"/v1/objectives/{obj['id']}/proposals/{revised['id']}/accept").json()
    assert (out["plan"][0]["id"], out["plan"][0]["status"]) == (plan[0]["id"], "done")
    assert [t["title"] for t in out["plan"]] == ["a", "c"]
    with _raises(ErrorCode.CONFLICT):
        client.post(f"/v1/objectives/{obj['id']}/proposals/{revised['id']}/accept")


def test_one_open_proposal_and_unknown_task_id(client: TestClient) -> None:
    obj = _create(client)
    first = obj["open_proposal"]["id"]
    second = client.post(
        f"/v1/objectives/{obj['id']}/proposals", json={"reason": "r", "plan": [{"title": "z"}]}
    ).json()
    got = client.get(f"/v1/objectives/{obj['id']}").json()
    assert got["open_proposal"]["id"] == second["id"] != first
    with _raises(ErrorCode.INVALID_INPUT):
        client.post(
            f"/v1/objectives/{obj['id']}/proposals",
            json={"reason": "r", "plan": [{"id": uuid.uuid4().hex, "title": "z"}]},
        )
    dismissed = client.post(f"/v1/objectives/{obj['id']}/proposals/{second['id']}/dismiss").json()
    assert dismissed["open_proposal"] is None


def test_patch_status_pauses_cadence_task(client: TestClient, db_uri: str) -> None:
    obj = _create(client)
    out = client.patch(
        f"/v1/objectives/{obj['id']}", json={"status": "paused", "due": "2026-12-31"}
    )
    assert out.json()["status"] == "paused" and out.json()["due"] == "2026-12-31"
    task = SqlAlchemyScheduledTaskStore(db_uri).get(obj["scheduled_task_id"])
    assert task is not None and task.state == "paused"
    for body in ({"status": "x"}, {"due": "soon"}):
        with _raises(ErrorCode.INVALID_INPUT):
            client.patch(f"/v1/objectives/{obj['id']}", json=body)


def test_log_lists_runs_newest_first(client: TestClient, db_uri: str) -> None:
    obj = _create(client)
    sched = SqlAlchemyScheduledTaskStore(db_uri)
    for at, status in ((100, "succeeded"), (200, "skipped")):
        sched.create_run(uuid.uuid4().hex, obj["scheduled_task_id"], status, at)
    log = client.get(f"/v1/objectives/{obj['id']}/log").json()["log"]
    assert [e["scheduled_at"] for e in log] == [200, 100]
    assert log[0]["status"] == "skipped" and log[1]["result"] is None


def test_other_owner_gets_404(db_uri: str) -> None:
    mine = TestClient(_app(db_uri))
    obj = _create(mine)
    store = SqlAlchemyObjectiveStore(db_uri)
    store.update(obj["id"])  # touch
    # Re-own the row to another user, as a second account would see it.
    from sqlalchemy.orm import Session

    from omnigent.db.db_models import SqlObjective, current_workspace_id
    from omnigent.db.utils import get_or_create_engine

    with Session(get_or_create_engine(db_uri)) as s:
        row = s.get(SqlObjective, (current_workspace_id(), obj["id"]))
        row.user_id = "someone-else"
        s.commit()
    assert mine.get("/v1/objectives").json() == {"objectives": []}
    with _raises(ErrorCode.NOT_FOUND):
        mine.get(f"/v1/objectives/{obj['id']}")
    with _raises(ErrorCode.NOT_FOUND):
        mine.patch(f"/v1/objectives/{obj['id']}", json={"title": "x"})
