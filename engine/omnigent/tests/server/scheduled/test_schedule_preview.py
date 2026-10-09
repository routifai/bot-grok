"""RRULE preview (next fires in the person's timezone), empty PATCH, and the stable phase."""

from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.server.routes.scheduled_tasks import create_scheduled_tasks_router
from omnigent.server.scheduled.rrule import next_fire_times, validate_rrule
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore

_PARIS = ZoneInfo("Europe/Paris")
_UTC = ZoneInfo("UTC")
_EVERY_OTHER_FRIDAY = "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;BYHOUR=9;BYMINUTE=0"


def _at(*parts: int, tz: ZoneInfo = _PARIS) -> datetime:
    return datetime(*parts, tzinfo=tz)


def _local(fires: list[datetime]) -> list[str]:
    return [f.astimezone(_PARIS).strftime("%Y-%m-%d %H:%M") for f in fires]


# ── stable phase for INTERVAL>1 ─────────────────────────────────────────────────────────


def test_every_other_friday_keeps_its_phase_across_restarts_mid_cycle() -> None:
    created = _at(2026, 10, 9, 10)  # a Friday: fires Oct 9 (passed), Oct 23, Nov 6
    expected = ["2026-10-23 09:00", "2026-11-06 09:00", "2026-11-20 09:00"]
    # The scheduler re-arms from whatever the clock says after a restart: every day of the
    # cycle must agree on the same fortnightly phase.
    for day in (10, 11, 14, 16, 17, 22):
        after = _at(2026, 10, day, 8)
        got = next_fire_times(_EVERY_OTHER_FRIDAY, after, _PARIS, 3, created)
        assert _local(got) == expected, f"re-armed on Oct {day}"


def test_without_an_anchor_the_phase_follows_the_query_day() -> None:
    # The old behavior, kept for callers with no task: it is why the anchor exists.
    a = next_fire_times(_EVERY_OTHER_FRIDAY, _at(2026, 10, 10, 8), _PARIS, 1)
    b = next_fire_times(_EVERY_OTHER_FRIDAY, _at(2026, 10, 14, 8), _PARIS, 1)
    assert _local(a) != _local(b)


def test_every_five_hours_does_not_drift_across_midnight() -> None:
    rule = "FREQ=HOURLY;INTERVAL=5"
    created = _at(
        2026, 10, 9, 10
    )  # phase: 00:00 + 5h steps from Oct 9 (00, 05, 10, 15, 20, 01...)
    late = next_fire_times(rule, _at(2026, 10, 9, 23, 30), _PARIS, 2, created)
    next_day = next_fire_times(rule, _at(2026, 10, 10, 0, 30), _PARIS, 2, created)
    assert _local(late) == _local(next_day)


def test_every_other_friday_survives_the_october_25_dst_change_in_paris() -> None:
    created = _at(2026, 10, 9, 10)
    fires = next_fire_times(_EVERY_OTHER_FRIDAY, _at(2026, 10, 24, 12), _PARIS, 2, created)
    # Oct 25 turns clocks back an hour: Oct 23 is CEST (+02:00), Nov 6 is CET (+01:00), and the
    # person's 09:00 stays 09:00 on the wall.
    assert _local(fires) == ["2026-11-06 09:00", "2026-11-20 09:00"]
    assert [f.utcoffset().total_seconds() / 3600 for f in fires] == [1.0, 1.0]
    before = next_fire_times(_EVERY_OTHER_FRIDAY, _at(2026, 10, 10, 12), _PARIS, 2, created)
    assert [f.utcoffset().total_seconds() / 3600 for f in before] == [2.0, 1.0]
    assert _local(before) == ["2026-10-23 09:00", "2026-11-06 09:00"]


def test_other_rules_ignore_the_anchor() -> None:
    created = _at(2026, 1, 1, 10)
    rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0"
    after = _at(2026, 10, 9, 12)
    assert next_fire_times(rule, after, _PARIS, 2, created) == next_fire_times(
        rule, after, _PARIS, 2
    )


def test_trigger_carries_the_anchor_to_the_scheduler() -> None:
    created = _at(2026, 10, 9, 10, tz=_UTC)
    trigger = validate_rrule(_EVERY_OTHER_FRIDAY).anchored(created)
    nxt = trigger.next_fire_after(_at(2026, 10, 14, 8), _PARIS)
    assert nxt is not None and nxt.strftime("%Y-%m-%d") == "2026-10-23"


# ── routes ──────────────────────────────────────────────────────────────────────────────

_AGENT = uuid.uuid4().hex


class _Agent:
    id = _AGENT
    session_id = None
    bundle_location = None


class _AgentStore:
    def get(self, agent_id: str) -> _Agent | None:
        return _Agent() if agent_id == _AGENT else None


class _ConvStore:
    def get_conversation(self, conversation_id: str) -> None:
        return None


@pytest.fixture()
def client(db_uri: str) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_scheduled_tasks_router(
            SqlAlchemyScheduledTaskStore(db_uri),
            agent_store=_AgentStore(),
            conversation_store=_ConvStore(),
        ),
        prefix="/v1",
    )
    return TestClient(app)


def _task(**extra: object) -> dict[str, object]:
    return {"name": "n", "prompt": "p", "agent_id": _AGENT, **extra}


def test_create_returns_the_next_three_fires_in_the_persons_timezone(client: TestClient) -> None:
    resp = client.post(
        "/v1/scheduled-tasks",
        json=_task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=30", timezone="Asia/Tokyo"),
    )
    assert resp.status_code == 200, resp.text
    fires = resp.json()["next_fire_times"]
    assert len(fires) == 3
    assert all(f.endswith("+09:00") and f[11:16] == "09:30" for f in fires)


def test_update_rule_changes_the_previewed_fires(client: TestClient) -> None:
    created = client.post(
        "/v1/scheduled-tasks",
        json=_task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timezone="Europe/Paris"),
    ).json()
    resp = client.patch(
        f"/v1/scheduled-tasks/{created['id']}",
        json={"rrule": "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rrule"] == "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0"
    assert [datetime.fromisoformat(f).weekday() for f in body["next_fire_times"]] == [4, 4, 4]
    assert all(f[11:16] == "17:00" for f in body["next_fire_times"])


def test_paused_task_previews_nothing(client: TestClient) -> None:
    created = client.post(
        "/v1/scheduled-tasks", json=_task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    ).json()
    paused = client.patch(f"/v1/scheduled-tasks/{created['id']}", json={"state": "paused"}).json()
    assert paused["next_fire_times"] == []


def test_empty_patch_is_refused_not_silently_accepted(client: TestClient) -> None:
    created = client.post(
        "/v1/scheduled-tasks", json=_task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    ).json()
    with pytest.raises(OmnigentError, match="nothing to update"):
        client.patch(f"/v1/scheduled-tasks/{created['id']}", json={})


def test_preview_validates_and_shows_fires_without_saving(client: TestClient) -> None:
    resp = client.post(
        "/v1/scheduled-tasks/preview-schedule",
        json={"rrule": _EVERY_OTHER_FRIDAY, "timezone": "Europe/Paris"},
    )
    body = resp.json()
    assert body["timezone"] == "Europe/Paris" and len(body["next_fire_times"]) == 3
    assert all(f[11:16] == "09:00" for f in body["next_fire_times"])
    assert client.get("/v1/scheduled-tasks").json() == {"scheduled_tasks": []}


@pytest.mark.parametrize("rule", ["FREQ=MINUTELY", "FREQ=WEEKLY;BYDAY=XX", "nonsense"])
def test_preview_refuses_a_rule_the_scheduler_would_refuse(client: TestClient, rule: str) -> None:
    with pytest.raises(OmnigentError, match="invalid rrule"):
        client.post("/v1/scheduled-tasks/preview-schedule", json={"rrule": rule})


def test_create_requires_an_rrule_and_rejects_schedule_text(client: TestClient) -> None:
    assert client.post("/v1/scheduled-tasks", json=_task()).status_code == 422
    body = _task(rrule="FREQ=DAILY;BYHOUR=9", schedule="every day")
    assert client.post("/v1/scheduled-tasks", json=body).status_code == 422
