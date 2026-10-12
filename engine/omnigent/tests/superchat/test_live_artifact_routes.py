"""``/v1/artifacts/{id}/live`` and the Helper's ``/v1/live-artifacts`` routes."""

from __future__ import annotations

import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.artifacts.routes import create_artifacts_router
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
from omnigent.superchat.live.feature import LIVE_FEATURE
from omnigent.superchat.live.handlers import build_rrule
from omnigent.superchat.live.routes import create_live_router
from omnigent.superchat.live.service import LiveService
from omnigent.superchat.live.store import SqlAlchemyLiveStore

_SESSION = uuid.uuid4().hex
ALICE = {"x-user": "alice"}
BOB = {"x-user": "bob"}
PAGE = b'<html><body><p data-superchat-id="btc">Bitcoin: 100</p></body></html>'
RRULE = "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0"


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("x-user")


class _Convs:
    def get_conversation(self, _id: str) -> Any:
        return SimpleNamespace(agent_id=uuid.uuid4().hex)


@pytest.fixture()
def env(db_uri: str, tmp_path: Path):
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    artifacts = SqlAlchemyArtifactStore(db_uri, lambda: blobs)
    service = LiveService(
        artifacts, SqlAlchemyLiveStore(db_uri), SqlAlchemyScheduledTaskStore(db_uri), _Convs(),
        lambda: None,
    )  # fmt: skip
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message, "code": str(exc.code)}, exc.http_status)

    app.include_router(
        create_artifacts_router(artifacts, conversation_store=_Convs(), auth_provider=_Auth()),  # type: ignore[arg-type]
        prefix="/v1",
    )
    app.include_router(
        create_live_router(service, conversation_store=_Convs(), auth_provider=_Auth()),  # type: ignore[arg-type]
        prefix="/v1",
    )
    fired: list[str] = []

    async def run_now(_workspace: int, task_id: str) -> bool:
        fired.append(task_id)
        return True

    app.state.scheduled_task_run_now = run_now
    return SimpleNamespace(
        artifacts=artifacts, service=service, client=TestClient(app), fired=fired
    )


def _page(env: Any, name: str = "prices.html", data: bytes = PAGE, user: str = "alice"):
    kind = name.rsplit(".", 1)[1]
    return env.artifacts.create(
        user_id=user, parent_session_id=_SESSION, name=name, title="Prices", kind=kind,
        mime=KIND_MIME[kind], data=data,
    )  # fmt: skip


def _put(env: Any, artifact_id: str, **body: Any):
    return env.client.put(
        f"/v1/artifacts/{artifact_id}/live", json={"rrule": RRULE, "timezone": "UTC", **body},
        headers=ALICE,
    )  # fmt: skip


def test_put_get_delete_lifecycle(env) -> None:
    page = _page(env)
    assert env.client.get(f"/v1/artifacts/{page.id}/live", headers=ALICE).json() == {"live": None}
    live = _put(env, page.id, sources=[{"ref": "https://example.com"}], tell="every").json()[
        "live"
    ]
    assert live["rrule"] == RRULE and live["schedule"] == "active" and live["tell"] == "every"
    assert live["sources"] == [{"ref": "https://example.com", "label": "https://example.com"}]
    task = env.service.tasks.get(live["task_id"])
    assert (task.kind, task.agent_type, task.parent_session_id) == (
        "live_artifact",
        "worker",
        _SESSION,
    )
    assert "live_update_context" in task.prompt and "prices.html" in task.prompt
    assert (
        env.client.get(f"/v1/artifacts/{page.id}/live", headers=ALICE).json()["live"]["tell"]
        == "every"
    )
    assert env.client.delete(f"/v1/artifacts/{page.id}/live", headers=ALICE).json() == {
        "deleted": True
    }
    assert env.service.tasks.get(live["task_id"]) is None
    assert env.client.get(f"/v1/artifacts/{page.id}/live", headers=ALICE).json() == {"live": None}
    assert env.artifacts.get(page.id, user_id="alice") is not None


def test_only_html_pages_and_valid_schedules_are_accepted(env) -> None:
    deck = _page(env, "talk.deck.html")
    pdf = _page(env, "report.pdf", b"%PDF-1.4")
    page = _page(env)
    assert _put(env, deck.id).status_code == 400
    assert _put(env, pdf.id).status_code == 400
    assert _put(env, page.id, rrule="nonsense").status_code == 400
    assert _put(env, page.id, timezone="Mars/Base").status_code == 400
    assert _put(env, page.id, rrule=RRULE, tell="loud").status_code == 422


def test_another_owner_gets_a_404_everywhere(env) -> None:
    page = _page(env)
    _put(env, page.id)
    base = f"/v1/artifacts/{page.id}/live"
    assert env.client.get(base, headers=BOB).status_code == 404
    assert env.client.put(base, json={"rrule": RRULE}, headers=BOB).status_code == 404
    assert env.client.delete(base, headers=BOB).status_code == 404
    assert env.client.post(f"{base}/run", headers=BOB).status_code == 404
    assert env.client.post(f"{base}/undo", headers=BOB).status_code == 404
    assert (
        env.client.post(f"{base}/accept", json={"element_id": "btc"}, headers=BOB).status_code
        == 404
    )
    helper = "/v1/live-artifacts/context"
    assert (
        env.client.get(
            f"{helper}?parent_session_id={_SESSION}&name=prices.html", headers=BOB
        ).status_code
        == 404
    )


def test_run_now_fires_the_task(env) -> None:
    page = _page(env)
    task_id = _put(env, page.id).json()["live"]["task_id"]
    assert env.client.post(f"/v1/artifacts/{page.id}/live/run", headers=ALICE).status_code == 202
    assert env.fired == [task_id]


def test_helper_round_trip_then_undo_and_stale_base(env) -> None:
    page = _page(env)
    _put(env, page.id)
    q = f"parent_session_id={_SESSION}&name=prices.html"
    ctx = env.client.get(f"/v1/live-artifacts/context?{q}", headers=ALICE).json()
    assert ctx["version"] == 1 and ctx["defer"] is False and "Bitcoin: 100" in ctx["source"]
    change = {"id": "btc", "after": "Bitcoin: 150", "notable": True}
    body = {"base_version": 1, "changes": [change],
            "facts": {"https://example.com": {"hash": "a", "values": {"btc": 150}}}}  # fmt: skip
    saved = env.client.post(f"/v1/live-artifacts/save?{q}", json=body, headers=ALICE).json()
    assert saved["version"] == 2 and saved["tell"] == "notable" and saved["applied"][0]["notable"]
    stale = env.client.post(f"/v1/live-artifacts/save?{q}", json=body, headers=ALICE)
    assert stale.status_code == 409 and stale.json()["code"] == "artifact_stale"
    live = env.client.get(f"/v1/artifacts/{page.id}/live", headers=ALICE).json()["live"]
    assert live["last_update"]["version"] == 2 and live["checked_at"]
    undone = env.client.post(f"/v1/artifacts/{page.id}/live/undo", headers=ALICE).json()
    assert undone["origin"] == "restore" and undone["version"] == 3
    again = env.client.post(f"/v1/artifacts/{page.id}/live/undo", headers=ALICE)
    assert again.status_code == 409
    checked = env.client.post(f"/v1/live-artifacts/checked?{q}", json={"facts": {}}, headers=ALICE)
    assert checked.json()["version"] is None


def test_accept_route_applies_the_source_value(env) -> None:
    page = _page(env)
    _put(env, page.id)
    q = f"parent_session_id={_SESSION}&name=prices.html"
    facts: dict[str, Any] = {}
    env.client.post(f"/v1/live-artifacts/save?{q}", headers=ALICE, json={
        "base_version": 1, "changes": [{"id": "btc", "after": "Bitcoin: 150"}],
        "facts": facts})  # fmt: skip
    head = env.artifacts.newest(page)
    env.artifacts.create(
        user_id="alice", parent_session_id=_SESSION, name=page.name, title=page.title,
        kind="html", mime=page.mime, origin="manual",
        data=env.artifacts.read(head).replace(b"Bitcoin: 150", b"Bitcoin: mine"),
    )  # fmt: skip
    env.client.post(f"/v1/live-artifacts/save?{q}", headers=ALICE, json={
        "base_version": 3, "changes": [{"id": "btc", "after": "Bitcoin: 160"}],
        "facts": facts})  # fmt: skip
    done = env.client.post(
        f"/v1/artifacts/{page.id}/live/accept", json={"element_id": "btc"}, headers=ALICE
    )
    assert done.status_code == 200 and done.json()["version"] == 4
    assert (
        env.client.post(
            f"/v1/artifacts/{page.id}/live/accept", json={"element_id": "btc"}, headers=ALICE
        ).status_code
        == 404
    )


def test_tools_are_offered_by_role() -> None:
    from omnigent.context.labels import (
        CONTEXT_MODE_LABEL,
        SUBAGENT_LABEL_KEY,
        SUPERSIDE_CHAT_MODE_VALUE,
    )
    from omnigent.superchat.feature import ToolManagerCtx

    def names(labels: dict[str, str]) -> list[str]:
        return [t.name() for t in LIVE_FEATURE.tools(labels, ToolManagerCtx())]

    chat = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
    assert names(chat) == ["artifact_keep_updated", "artifact_stop_updating"]
    assert names({**chat, SUBAGENT_LABEL_KEY: "worker"}) == [
        "live_update_context", "live_update_save", "live_update_checked",
    ]  # fmt: skip
    assert names({}) == []
    assert set(LIVE_FEATURE.handlers) >= {"artifact_keep_updated", "live_update_save"}


def test_tool_schedule_becomes_an_rrule() -> None:
    assert (
        build_rrule({"frequency": "daily", "time": "07:30"}) == "FREQ=DAILY;BYHOUR=7;BYMINUTE=30"
    )
    assert build_rrule({"frequency": "weekly", "time": "8:00", "weekday": "Monday"}) == RRULE
    assert build_rrule({"frequency": "monthly", "time": "09:00", "month_day": 1}) == (
        "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0"
    )
    for bad in (
        {"frequency": "weekly", "time": "08:00"},
        {"frequency": "monthly", "time": "08:00", "month_day": 31},
        {"frequency": "daily", "time": "25:00"},
        {"frequency": "hourly", "time": "08:00"},
    ):
        with pytest.raises(ValueError):
            build_rrule(bad)
