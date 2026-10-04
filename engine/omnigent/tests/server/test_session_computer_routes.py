"""Tests for the session computer routes (screen view, take over, release).

Offline: a stub launcher stands in for the sandbox provider; no supervisor or Docker.
"""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest
import pytest_asyncio
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.onboarding.sandboxes.types import SandboxCapabilities
from omnigent.server.routes.sessions import routes_computer
from omnigent.server.routes.sessions.routes_computer import register_computer_routes

pytestmark = pytest.mark.asyncio


class StubLauncher:
    provider = "computer"

    def __init__(self, *, screen: bool = True) -> None:
        self.capabilities = SandboxCapabilities(screen=screen)
        self.calls: list[tuple[str, object]] = []

    def screen_url(
        self, sandbox_id: str, *, interactive: bool, control_token: str | None = None
    ) -> str:
        self.calls.append(("screen_url", (interactive, control_token)))
        return f"http://viewer/{'ctl' if interactive else 'view'}?t={control_token or 'v'}"

    def release_control(self, sandbox_id: str) -> None:
        self.calls.append(("release", sandbox_id))


def _app(launcher: StubLauncher | None, *, with_host: bool = True) -> FastAPI:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _omnigent_error(_request: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": str(exc)}, status_code=exc.http_status)

    router = APIRouter(prefix="/v1")
    conv = SimpleNamespace(host_id="host_1" if with_host else None)
    store = SimpleNamespace(get_conversation=lambda _sid: conv)
    register_computer_routes(router, conversation_store=store)  # type: ignore[arg-type]
    app.include_router(router)
    host = SimpleNamespace(sandbox_provider="computer", sandbox_id="bot:space:cid")
    app.state.host_store = SimpleNamespace(get_host=lambda _hid: host)
    entry = SimpleNamespace(launcher_factory=lambda: launcher)
    app.state.sandbox_config = SimpleNamespace(recorded=lambda _p: entry)
    return app


@pytest_asyncio.fixture(autouse=True)
async def _clean_control_state() -> None:
    routes_computer._control_tokens.clear()


async def _client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_status_reports_available_and_not_in_control() -> None:
    async with await _client(_app(StubLauncher())) as c:
        r = await c.get("/v1/sessions/conv_1/computer")
    assert r.json() == {"available": True, "in_control": False}


async def test_status_unavailable_without_a_screen_capable_sandbox() -> None:
    async with await _client(_app(StubLauncher(screen=False))) as c:
        r = await c.get("/v1/sessions/conv_1/computer")
    assert r.json() == {"available": False, "in_control": False}


async def test_take_over_then_release_round_trip() -> None:
    launcher = StubLauncher()
    async with await _client(_app(launcher)) as c:
        taken = await c.post("/v1/sessions/conv_1/computer/screen", json={"interactive": True})
        assert taken.status_code == 200
        assert taken.json()["in_control"] is True
        assert "/ctl?t=" in taken.json()["screen_url"]
        token = launcher.calls[0][1][1]  # type: ignore[index]
        assert token and len(token) >= 16
        assert (await c.get("/v1/sessions/conv_1/computer")).json()["in_control"] is True

        released = await c.post("/v1/sessions/conv_1/computer/release")
        assert released.json() == {"screen_url": "http://viewer/view?t=v", "in_control": False}
        assert (await c.get("/v1/sessions/conv_1/computer")).json()["in_control"] is False
    assert ("release", "bot:space:cid") in launcher.calls


async def test_view_only_screen_does_not_take_control() -> None:
    async with await _client(_app(StubLauncher())) as c:
        r = await c.post("/v1/sessions/conv_1/computer/screen", json={"interactive": False})
    assert r.json() == {"screen_url": "http://viewer/view?t=v", "in_control": False}


async def test_screen_routes_404_when_session_has_no_computer() -> None:
    async with await _client(_app(StubLauncher(), with_host=False)) as c:
        r = await c.post("/v1/sessions/conv_1/computer/screen", json={"interactive": True})
    assert r.status_code == 404
