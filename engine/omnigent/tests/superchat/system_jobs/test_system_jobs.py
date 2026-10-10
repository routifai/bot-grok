"""``GET /v1/me/system-jobs``: the engine's own background jobs for the caller."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
from fastapi import FastAPI

from omnigent.entities import MemoryUpkeepRun
from omnigent.superchat.system_jobs.routes import create_system_jobs_router


class _Store:
    def list_runs(self, user_id: str, *, limit: int = 20) -> list[MemoryUpkeepRun]:
        run = MemoryUpkeepRun(
            run_id="r",
            user_id=user_id,
            window_since=0,
            window_until=10,
            state="succeeded",
            disposition="ok",
            counts={},
            started_at=100,
            finished_at=160,
        )
        return [run]


def _client(app: FastAPI) -> httpx.AsyncClient:
    app.include_router(create_system_jobs_router(app), prefix="/v1")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_jobs_report_last_and_next_run() -> None:
    app = FastAPI()
    app.state.memory_upkeep_coordinator = SimpleNamespace(upkeep_store=_Store())
    app.state.memory_upkeep_scheduler = SimpleNamespace(sweep_interval_s=3600, last_sweep_at=1000)
    app.state.side_chat_archive_sweeper = SimpleNamespace(
        interval_s=7200.0, last_sweep_at=500, enabled_for=lambda _key: False
    )
    async with _client(app) as http:
        jobs = (await http.get("/v1/me/system-jobs")).json()["jobs"]
    by_id = {j["id"]: j for j in jobs}
    upkeep = by_id["memory_upkeep"]
    assert upkeep["name"] == "Memory upkeep"
    assert upkeep["last_run_at"] == 160
    assert upkeep["next_run_at"] == 4600
    assert upkeep["enabled"] is True
    assert upkeep["schedule"].startswith("Every hour")
    archiving = by_id["side_chat_archiving"]
    assert archiving["schedule"] == "Every 2 hours"
    assert archiving["next_run_at"] == 7700
    assert archiving["enabled"] is False


async def test_jobs_listed_disabled_with_unknown_times_when_nothing_runs() -> None:
    app = FastAPI()
    async with _client(app) as http:
        jobs = (await http.get("/v1/me/system-jobs")).json()["jobs"]
    assert [j["id"] for j in jobs] == ["memory_upkeep", "side_chat_archiving"]
    for job in jobs:
        assert job["enabled"] is False
        assert job["last_run_at"] is None
        assert job["next_run_at"] is None
