"""Tests for ``POST /v1/sessions/{id}/computer/recording`` (offline: a stub recording launcher)."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.onboarding.sandboxes.recording import RecordingMixin, RecordingTrace
from omnigent.onboarding.sandboxes.types import SandboxCapabilities
from omnigent.superchat.computer.routes import register_computer_routes
from omnigent.superchat.taught_skills.store import SqlAlchemyTaughtSkillStore

pytestmark = pytest.mark.asyncio

SESSION = "0123456789abcdef0123456789abcdef"


class StubRecorder(RecordingMixin):
    provider = "computer"

    def __init__(self, *, recording: bool = True) -> None:
        self.capabilities = SandboxCapabilities(screen=True, recording=recording)
        self.calls: list[tuple[str, str]] = []
        self.fail_stop = False

    def start_recording(self, sandbox_id: str, recording_id: str) -> None:
        self.calls.append(("start", recording_id))

    def stop_recording(self, sandbox_id: str, recording_id: str) -> RecordingTrace:
        self.calls.append(("stop", recording_id))
        if self.fail_stop:
            raise RuntimeError("boom")
        return RecordingTrace(
            actions=[{"seq": 1, "kind": "navigate", "keyframe": "k1"}],
            keyframes={"k1": b"jpeg"},
        )


def _app(launcher: StubRecorder, store: SqlAlchemyTaughtSkillStore | None) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _err(_request: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=exc.http_status)

    router = APIRouter(prefix="/v1")
    conv = SimpleNamespace(host_id="host_1")
    register_computer_routes(
        router,
        conversation_store=SimpleNamespace(get_conversation=lambda _s: conv),  # type: ignore[arg-type]
    )
    app.include_router(router)
    host = SimpleNamespace(host_id="host_1", sandbox_provider="computer", sandbox_id="b:s:c")
    app.state.host_store = SimpleNamespace(get_host=lambda _h: host)
    entry = SimpleNamespace(launcher_factory=lambda: launcher)
    app.state.sandbox_config = SimpleNamespace(recorded=lambda _p: entry)
    if store is not None:
        app.state.taught_skill_store = store
    return app


def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_start_then_stop_stores_trace_and_returns_it(db_uri: str) -> None:
    store, launcher = SqlAlchemyTaughtSkillStore(db_uri), StubRecorder()
    url = f"/v1/sessions/{SESSION}/computer/recording"
    async with _client(_app(launcher, store)) as c:
        started = await c.post(url, json={"action": "start", "goal": "search shoes"})
        assert started.status_code == 200, started.text
        ids = started.json()
        assert ids["status"] == "recording"
        again = await c.post(url, json={"action": "start", "goal": "x"})
        assert again.status_code == 409

        stopped = await c.post(url, json={"action": "stop"})
        assert stopped.status_code == 200, stopped.text
        body = stopped.json()
        assert body["status"] == "drafting" and body["skill_id"] == ids["skill_id"]
        assert body["actions"][0]["keyframe"] == "k1" and body["keyframes"] == ["k1"]
        assert (await c.post(url, json={"action": "stop"})).status_code == 409
    assert store.keyframe(ids["recording_id"], "k1") == b"jpeg"
    skill = store.get_skill(ids["skill_id"], user_id=None)
    assert skill is not None and skill.status == "drafting" and skill.goal == "search shoes"
    assert [c[0] for c in launcher.calls] == ["start", "stop"]


async def test_failed_stop_fails_the_skill(db_uri: str) -> None:
    store, launcher = SqlAlchemyTaughtSkillStore(db_uri), StubRecorder()
    url = f"/v1/sessions/{SESSION}/computer/recording"
    async with _client(_app(launcher, store)) as c:
        ids = (await c.post(url, json={"action": "start", "goal": "g"})).json()
        launcher.fail_stop = True
        with pytest.raises(RuntimeError):
            await c.post(url, json={"action": "stop"})
    assert store.get_skill(ids["skill_id"], user_id=None).status == "failed"  # type: ignore[union-attr]


async def test_validation_and_unavailable(db_uri: str) -> None:
    store = SqlAlchemyTaughtSkillStore(db_uri)
    url = f"/v1/sessions/{SESSION}/computer/recording"
    async with _client(_app(StubRecorder(), store)) as c:
        assert (await c.post(url, json={"action": "pause"})).status_code == 400
        assert (await c.post(url, json={"action": "start"})).status_code == 400
        assert (await c.post(url, json={"action": "stop"})).status_code == 409
    async with _client(_app(StubRecorder(recording=False), store)) as c:
        assert (await c.post(url, json={"action": "start", "goal": "g"})).status_code == 404
    async with _client(_app(StubRecorder(), None)) as c:
        assert (await c.post(url, json={"action": "start", "goal": "g"})).status_code == 404
