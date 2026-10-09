"""Plain-words schedule to RRULE: prompt, cleaning, validation, timezone, and the routes."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.server.routes.scheduled_tasks import create_scheduled_tasks_router
from omnigent.server.scheduled.nlp import (
    SCHEDULE_PROMPT,
    clean_rrule_answer,
    natural_language_to_rrule,
)
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore

_NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)  # Friday


class _Caller:
    """A fake model: answers with *answer* and remembers what it was asked."""

    def __init__(self, answer: str | Exception) -> None:
        self.answer = answer
        self.calls: list[dict[str, str]] = []

    async def __call__(self, *, instructions: str, input_text: str) -> str:
        self.calls.append({"instructions": instructions, "input_text": input_text})
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"),
        ("RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0", "FREQ=DAILY;BYHOUR=8;BYMINUTE=0"),
        ("```\nfreq=daily;byhour=8;byminute=0\n```", "FREQ=DAILY;BYHOUR=8;BYMINUTE=0"),
        ('"FREQ=HOURLY"\nThis fires every hour.', "FREQ=HOURLY"),
        ("NONE", None),
        ("none", None),
        ("", None),
        ("I cannot do that.", None),
    ],
)
def test_clean_rrule_answer(answer: str, expected: str | None) -> None:
    assert clean_rrule_answer(answer) == expected


@pytest.mark.asyncio
async def test_every_monday_at_9_becomes_a_validated_rrule() -> None:
    caller = _Caller("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")
    rule = await natural_language_to_rrule(
        "every Monday at 9", timezone="Europe/Paris", llm_caller=caller, now=_NOW
    )
    assert rule == "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"
    (call,) = caller.calls
    assert call["input_text"] == "Schedule: every Monday at 9"
    assert call["instructions"].startswith(SCHEDULE_PROMPT)


@pytest.mark.asyncio
async def test_the_model_is_told_the_persons_local_clock() -> None:
    caller = _Caller("FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    await natural_language_to_rrule("daily", timezone="Asia/Tokyo", llm_caller=caller, now=_NOW)
    assert "Asia/Tokyo" in caller.calls[0]["instructions"]
    assert "Friday 2026-10-09 21:00" in caller.calls[0]["instructions"]


@pytest.mark.asyncio
async def test_unknown_timezone_falls_back_to_utc() -> None:
    caller = _Caller("FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    await natural_language_to_rrule("daily", timezone="Mars/Base", llm_caller=caller, now=_NOW)
    assert "timezone is UTC" in caller.calls[0]["instructions"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        "NONE",
        "FREQ=MINUTELY;INTERVAL=5",  # more often than hourly: the scheduler refuses it
        "FREQ=WEEKLY;BYDAY=XX;BYHOUR=9",  # malformed
        "FREQ=YEARLY;COUNT=1",  # fires once
        "tomorrow at noon",
    ],
)
async def test_rules_the_scheduler_would_refuse_are_never_returned(answer: str) -> None:
    caller = _Caller(answer)
    assert await natural_language_to_rrule("x", llm_caller=caller, now=_NOW) is None


@pytest.mark.asyncio
async def test_no_model_empty_text_and_model_failure_all_give_none() -> None:
    assert await natural_language_to_rrule("every day", llm_caller=None) is None
    caller = _Caller("FREQ=DAILY")
    assert await natural_language_to_rrule("   ", llm_caller=caller) is None
    assert caller.calls == []
    boom = _Caller(RuntimeError("provider down"))
    assert await natural_language_to_rrule("every day", llm_caller=boom) is None


def test_prompt_examples_are_themselves_valid_rules() -> None:
    from omnigent.server.scheduled.rrule import validate_rrule

    for line in SCHEDULE_PROMPT.splitlines():
        if " -> " in line and not line.endswith("NONE"):
            validate_rrule(line.split(" -> ", 1)[1])


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


def _client(db_uri: str, answer: str | Exception) -> tuple[TestClient, _Caller]:
    app = FastAPI()
    caller = _Caller(answer)
    app.state.schedule_llm_caller = caller
    app.include_router(
        create_scheduled_tasks_router(
            SqlAlchemyScheduledTaskStore(db_uri),
            agent_store=_AgentStore(),
            conversation_store=_ConvStore(),
        ),
        prefix="/v1",
    )
    return TestClient(app), caller


def _task(**extra: Any) -> dict[str, Any]:
    return {"name": "n", "prompt": "p", "agent_id": _AGENT, **extra}


def test_create_with_schedule_text_stores_the_parsed_rrule(db_uri: str) -> None:
    client, caller = _client(db_uri, "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0")
    resp = client.post(
        "/v1/scheduled-tasks",
        json=_task(schedule="every Monday at 9", timezone="America/New_York"),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["rrule"] == "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"
    assert "America/New_York" in caller.calls[0]["instructions"]


def test_create_needs_exactly_one_of_rrule_or_schedule(db_uri: str) -> None:
    client, _ = _client(db_uri, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    assert client.post("/v1/scheduled-tasks", json=_task()).status_code == 422
    both = _task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0", schedule="daily")
    assert client.post("/v1/scheduled-tasks", json=both).status_code == 422


def test_unreadable_schedule_is_refused_with_the_fix(db_uri: str) -> None:
    client, _ = _client(db_uri, "NONE")
    with pytest.raises(OmnigentError, match="send an rrule or ask the person to rephrase"):
        client.post("/v1/scheduled-tasks", json=_task(schedule="every 5 seconds"))


def test_update_accepts_schedule_text(db_uri: str) -> None:
    client, _ = _client(db_uri, "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0")
    created = client.post(
        "/v1/scheduled-tasks", json=_task(rrule="FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
    ).json()
    resp = client.patch(
        f"/v1/scheduled-tasks/{created['id']}", json={"schedule": "Fridays at 5pm"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["rrule"] == "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0"
    with pytest.raises(OmnigentError, match="at most one"):
        client.patch(
            f"/v1/scheduled-tasks/{created['id']}",
            json={"schedule": "daily", "rrule": "FREQ=DAILY;BYHOUR=9"},
        )


def test_parse_schedule_previews_without_saving(db_uri: str) -> None:
    client, _ = _client(db_uri, "FREQ=DAILY;BYHOUR=8;BYMINUTE=0")
    resp = client.post(
        "/v1/scheduled-tasks/parse-schedule",
        json={"text": "every day at 8am", "timezone": "Europe/Paris"},
    )
    assert resp.json() == {"rrule": "FREQ=DAILY;BYHOUR=8;BYMINUTE=0", "timezone": "Europe/Paris"}
    assert client.get("/v1/scheduled-tasks").json() == {"scheduled_tasks": []}
