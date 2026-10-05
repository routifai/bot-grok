"""Tests for the standing proactive runs (Study) and their provisioning."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from omnigent.superchat.proactive.provisioner import (
    CHECKIN_NAME,
    STUDY_NAME,
    ProactiveProvisioner,
    desired_tasks,
    provisioning_enabled,
)


def test_desired_tasks_follow_proactivity() -> None:
    normal = {t.name: t for t in desired_tasks("normal")}
    assert normal[STUDY_NAME].rrule == "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"
    assert list(normal) == [STUDY_NAME]  # no scheduled Check-in any more
    assert all(t.active for t in normal.values())

    low = {t.name: t for t in desired_tasks("low")}
    assert low[STUDY_NAME].active and "FREQ=WEEKLY" in low[STUDY_NAME].rrule

    assert not any(t.active for t in desired_tasks("off"))


def test_provisioning_is_opt_in() -> None:
    assert not provisioning_enabled({})
    assert provisioning_enabled({"OMNIGENT_PROACTIVE_PROVISION": "1"})


class _FakeServer(ProactiveProvisioner):
    """Provisioner whose HTTP calls hit an in-memory task list."""

    def __init__(self, proactivity: str = "normal", timezone: str = "Europe/Paris") -> None:
        super().__init__(app=None)
        self.prefs = {"proactivity": proactivity, "timezone": timezone}
        self.tasks: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str]] = []

    async def _call(self, headers, method, path, body):  # type: ignore[no-untyped-def]
        self.calls.append((method, path))
        request = httpx.Request(method, "http://internal" + path)
        if path == "/me/proactivity":
            return httpx.Response(200, json=self.prefs, request=request)
        if method == "GET":
            return httpx.Response(200, json={"scheduled_tasks": self.tasks}, request=request)
        if method == "POST":
            task = {"id": f"t{len(self.tasks)}", "state": "active", **(body or {})}
            self.tasks.append(task)
            return httpx.Response(200, json=task, request=request)
        task = next(t for t in self.tasks if path.endswith(t["id"]))
        if method == "DELETE":
            self.tasks.remove(task)
            return httpx.Response(204, request=request)
        task.update(body or {})
        return httpx.Response(200, json=task, request=request)


@pytest.mark.asyncio
async def test_ensure_creates_the_study_once() -> None:
    server = _FakeServer()
    assert await server.ensure("s1", {})
    assert [t["name"] for t in server.tasks] == [STUDY_NAME]
    assert all(
        t["agent_type"] == "analyst" and t["parent_session_id"] == "s1" for t in server.tasks
    )
    assert all(t["timezone"] == "Europe/Paris" for t in server.tasks)
    server.calls.clear()
    assert await server.ensure("s1", {})
    assert server.calls == [("GET", "/me/proactivity")]  # cached: nothing else on later turns


@pytest.mark.asyncio
async def test_ensure_is_idempotent_across_restarts() -> None:
    server = _FakeServer()
    await server.ensure("s1", {})
    restarted = _FakeServer()
    restarted.tasks = server.tasks
    await restarted.ensure("s1", {})
    assert len(restarted.tasks) == 1
    assert not [c for c in restarted.calls if c[0] in ("POST", "PATCH")]


@pytest.mark.asyncio
async def test_level_change_reconciles_existing_tasks() -> None:
    server = _FakeServer()
    await server.ensure("s1", {})
    server.prefs["proactivity"] = "low"
    await server.ensure("s1", {})
    by_name = {t["name"]: t for t in server.tasks}
    assert by_name[STUDY_NAME]["rrule"].startswith("FREQ=WEEKLY;BYDAY=MO;BYHOUR=7")
    server.prefs["proactivity"] = "off"
    await server.ensure("s1", {})
    assert {t["state"] for t in server.tasks} == {"paused"}


@pytest.mark.asyncio
async def test_existing_checkin_task_is_deleted() -> None:
    server = _FakeServer()
    server.tasks = [{"id": "old", "name": CHECKIN_NAME, "state": "active"}]
    await server.ensure("s1", {})
    assert [t["name"] for t in server.tasks] == [STUDY_NAME]
    assert ("DELETE", "/scheduled-tasks/old") in server.calls


@pytest.mark.asyncio
async def test_off_creates_nothing_and_failure_backs_off() -> None:
    server = _FakeServer(proactivity="off")
    await server.ensure("s1", {})
    assert server.tasks == []

    class _Broken(_FakeServer):
        async def _call(self, headers, method, path, body):  # type: ignore[no-untyped-def]
            self.calls.append((method, path))
            raise RuntimeError(json.dumps({"boom": True}))

    broken = _Broken()
    assert not await broken.ensure("s1", {})
    broken.calls.clear()
    assert not await broken.ensure("s1", {})
    assert broken.calls == []  # backing off, no hammering


def test_study_prompt_checks_existing_work_before_proposing() -> None:
    from omnigent.superchat.proactive.provisioner import STUDY_PROMPT

    for needle in (
        "sys_scheduled_task_list",
        "suggestion_list",
        "memory_search",
        "session_history",
    ):
        assert needle in STUDY_PROMPT
