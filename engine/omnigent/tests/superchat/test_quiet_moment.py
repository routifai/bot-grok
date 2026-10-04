"""Tests for the quiet-moment pass: gating, caps, no wake, evening finalize."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.entities.scheduled_task import OwnerPreferences
from omnigent.stores.daily_note_store import SqlAlchemyDailyNoteStore
from omnigent.superchat import quiet_moment
from omnigent.superchat.quiet_moment import MAX_PASSES_PER_DAY, QuietMoment

SESSION = "b" * 32
NOON = datetime(2026, 10, 4, 12, 0, tzinfo=UTC).timestamp()
NIGHT = datetime(2026, 10, 4, 22, 30, tzinfo=UTC).timestamp()


class _Prefs:
    def __init__(self, prefs: OwnerPreferences | None = None) -> None:
        self.prefs = prefs

    def get_owner_preferences(self, owner: str) -> OwnerPreferences | None:
        return self.prefs


@pytest.fixture()
def harness(db_uri: str, monkeypatch: pytest.MonkeyPatch):
    started: list[dict[str, Any]] = []

    async def fake_start(deps: Any, **kwargs: Any) -> str:
        started.append(kwargs)
        return "helper"

    monkeypatch.setattr("omnigent.server.scheduled.fire.start_adhoc_helper", fake_start)
    prefs = _Prefs()
    deps = SimpleNamespace(
        scheduled_task_store=prefs,
        conversation_store=SimpleNamespace(get_session_owner=lambda sid: None),
    )
    notes = SqlAlchemyDailyNoteStore(db_uri)
    qm = QuietMoment(deps=deps, note_store=notes, idle_s=3600)
    return qm, notes, prefs, started


def _turns(qm: QuietMoment, n: int) -> None:
    qm._turns[SESSION] = n


@pytest.mark.asyncio
async def test_pass_needs_three_turns_then_runs_a_bounded_helper(harness) -> None:
    qm, notes, _prefs, started = harness
    _turns(qm, 2)
    assert not await qm._run_pass(SESSION, now=NOON)
    _turns(qm, 3)
    assert await qm._run_pass(SESSION, now=NOON)
    assert started[0]["agent_type"] == "analyst"
    assert started[0]["parent_session_id"] == SESSION
    assert "daily_note_update" in started[0]["content"][0]["text"]
    assert qm._turns[SESSION] == 0
    assert notes.get("local", "2026-10-04").quiet_passes == 1  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_daily_cap(harness) -> None:
    qm, _notes, _prefs, started = harness
    for _ in range(MAX_PASSES_PER_DAY + 2):
        _turns(qm, 3)
        await qm._run_pass(SESSION, now=NOON)
    assert len(started) == MAX_PASSES_PER_DAY


@pytest.mark.asyncio
async def test_proactivity_off_and_quiet_hours_hold_the_pass(harness) -> None:
    qm, _notes, prefs, started = harness
    prefs.prefs = OwnerPreferences(user_id="local", proactivity="off")
    _turns(qm, 5)
    assert not await qm._run_pass(SESSION, now=NOON)
    prefs.prefs = OwnerPreferences(
        user_id="local", quiet_start="11:00", quiet_end="13:00", timezone="UTC"
    )
    _turns(qm, 5)
    assert not await qm._run_pass(SESSION, now=NOON)
    assert started == []


@pytest.mark.asyncio
async def test_evening_finalize_runs_once(harness) -> None:
    qm, _notes, _prefs, started = harness
    _turns(qm, 3)
    await qm._run_pass(SESSION, now=NOON)
    started.clear()
    assert await qm.finalize_due(now=NOON) == 0  # too early in the day
    assert await qm.finalize_due(now=NIGHT) == 1
    assert "final pass" in started[0]["content"][0]["text"]
    assert await qm.finalize_due(now=NIGHT) == 0


def test_idle_seconds_env() -> None:
    assert quiet_moment.idle_seconds({}) == 1200.0
    assert quiet_moment.idle_seconds({quiet_moment.IDLE_SECONDS_ENV: "30"}) == 30.0
    assert quiet_moment.idle_seconds({quiet_moment.IDLE_SECONDS_ENV: "x"}) == 1200.0


@pytest.mark.asyncio
async def test_nightly_dreaming_and_people_run_once_after_finalize(
    harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    qm, notes, _prefs, started = harness
    service = SimpleNamespace(
        list_claims=lambda owner, kinds=None: [
            {"claim_id": "c1", "text": "Maya, manager", "person_authored": True}
        ]
    )
    monkeypatch.setattr("omnigent.runtime.get_memory_service", lambda: service)
    monkeypatch.setattr(quiet_moment, "_in_quiet_hours", lambda prefs, now: False)
    notes.write_sections(
        "local", "2026-10-04", {"talked_about": "- budget"}, parent_session_id=SESSION
    )
    notes.claim_finalize("local", "2026-10-04")
    later = time.time() + quiet_moment.NIGHTLY_DELAY_SECONDS + 60

    assert await qm.nightly_due(now=time.time()) == 0  # finalize pass still running
    assert await qm.nightly_due(now=later) == 2
    names = [call["name"] for call in started]
    assert names == ["Dreaming", "People"]
    assert all(call["agent_type"] == "analyst" for call in started)
    assert 'date: "2026-10-04"' in started[0]["content"][0]["text"]
    assert "c1 [edited]: Maya, manager" in started[1]["content"][0]["text"]
    assert await qm.nightly_due(now=later) == 0


@pytest.mark.asyncio
async def test_nightly_held_by_proactivity_off(harness, monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    qm, notes, prefs, started = harness
    prefs.prefs = OwnerPreferences(user_id="local", proactivity="off")
    monkeypatch.setattr("omnigent.runtime.get_memory_service", lambda: SimpleNamespace())
    notes.write_sections("local", "2026-10-04", {"talked_about": "- x"}, parent_session_id=SESSION)
    notes.claim_finalize("local", "2026-10-04")
    assert await qm.nightly_due(now=time.time() + 4000) == 0
    assert started == []
