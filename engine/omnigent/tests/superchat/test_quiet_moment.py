"""Tests for the quiet-moment pass: gating, caps, no wake, evening finalize."""

from __future__ import annotations

import time
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.entities.scheduled_task import OwnerPreferences
from omnigent.superchat.daily_notes import quiet_moment
from omnigent.superchat.daily_notes.quiet_moment import MAX_PASSES_PER_DAY, QuietMoment
from omnigent.superchat.daily_notes.store import SqlAlchemyDailyNoteStore

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

    monkeypatch.setattr("omnigent.server.scheduled.helper_fire.start_adhoc_helper", fake_start)
    prefs = _Prefs()
    deps = SimpleNamespace(
        scheduled_task_store=prefs,
        conversation_store=SimpleNamespace(get_session_owner=lambda sid: None),
    )
    notes = SqlAlchemyDailyNoteStore(db_uri)
    qm = QuietMoment(deps=deps, note_store=notes, idle_s=3600)
    return qm, notes, prefs, started


def _messages(notes: Any, monkeypatch: pytest.MonkeyPatch, stamps: list[int]) -> None:
    monkeypatch.setattr(
        notes, "recent_user_messages", lambda since: {SESSION: stamps} if stamps else {}
    )


def _stamps(n: int, last: float = NOON - 3600) -> list[int]:
    return [int(last) - 60 * i for i in range(n - 1, -1, -1)]


@pytest.mark.asyncio
async def test_pass_needs_three_turns_then_runs_a_bounded_helper(harness, monkeypatch) -> None:
    qm, notes, _prefs, started = harness
    _messages(notes, monkeypatch, _stamps(2))
    assert await qm.idle_due(now=NOON) == 0
    _messages(notes, monkeypatch, _stamps(3))
    assert await qm.idle_due(now=NOON) == 1
    assert started[0]["agent_type"] == "analyst"
    assert started[0]["parent_session_id"] == SESSION
    assert "daily_note_update" in started[0]["content"][0]["text"]
    assert notes.get("local", "2026-10-04").quiet_passes == 1  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_not_due_until_idle(harness, monkeypatch) -> None:
    qm, notes, _prefs, started = harness
    _messages(notes, monkeypatch, _stamps(3, last=NOON - 60))
    assert await qm.idle_due(now=NOON) == 0
    assert await qm.idle_due(now=NOON + 3600) == 1
    assert len(started) == 1


@pytest.mark.asyncio
async def test_pass_is_not_repeated_without_new_messages(harness, monkeypatch) -> None:
    qm, notes, _prefs, started = harness
    stamps = _stamps(3)
    _messages(notes, monkeypatch, stamps)
    assert await qm.idle_due(now=NOON) == 1
    # the claim stamped the note "now"; the same messages must not trigger another pass
    assert await qm.idle_due(now=NOON + 7200) == 0
    assert len(started) == 1


@pytest.mark.asyncio
async def test_restart_does_not_lose_a_due_pass(harness, monkeypatch, db_uri) -> None:
    """A fresh instance (as after a restart) still runs the pass: no in-memory state is needed."""
    qm, notes, _prefs, started = harness
    _messages(notes, monkeypatch, _stamps(3))
    fresh = QuietMoment(deps=qm._deps, note_store=notes, idle_s=3600)
    assert await fresh.idle_due(now=NOON) == 1
    assert len(started) == 1


@pytest.mark.asyncio
async def test_daily_cap(harness, monkeypatch) -> None:
    qm, notes, _prefs, started = harness
    for i in range(MAX_PASSES_PER_DAY + 2):
        _messages(notes, monkeypatch, _stamps(3, last=NOON - 4000 + 100 * i))
        # each round's messages are newer than the previous claim (claims stamp real time)
        monkeypatch.setattr(notes, "get", _note_before(notes.get))
        await qm.idle_due(now=NOON)
    assert len(started) == MAX_PASSES_PER_DAY


def _note_before(real: Any):
    def get(owner: str, day: str):
        note = real(owner, day)
        if note is not None:
            note.updated_at = 0
        return note

    return get


@pytest.mark.asyncio
async def test_proactivity_off_and_quiet_hours_hold_the_pass(harness, monkeypatch) -> None:
    qm, notes, prefs, started = harness
    _messages(notes, monkeypatch, _stamps(5))
    prefs.prefs = OwnerPreferences(user_id="local", proactivity="off")
    assert await qm.idle_due(now=NOON) == 0
    prefs.prefs = OwnerPreferences(
        user_id="local", quiet_start="11:00", quiet_end="13:00", timezone="UTC"
    )
    assert await qm.idle_due(now=NOON) == 0
    assert started == []


def test_store_reads_person_messages_of_live_super_chats(db_uri: str) -> None:
    """The persisted-data query counts person messages in top-level Super Chats only."""
    import json
    import uuid

    from sqlalchemy.orm import Session

    from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE
    from omnigent.db.db_models import (
        SqlConversation,
        SqlConversationItem,
        SqlConversationLabel,
    )
    from omnigent.db.utils import get_or_create_engine

    notes = SqlAlchemyDailyNoteStore(db_uri)
    chat, side = uuid.uuid4().hex, uuid.uuid4().hex
    with Session(get_or_create_engine(db_uri)) as db:
        for cid, labels in ((chat, {}), (side, {"omnigent.side_chat": "1"})):
            db.add(
                SqlConversation(
                    id=cid, created_at=1, updated_at=1, root_conversation_id=cid, archived=False
                )
            )
            for k, v in {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE, **labels}.items():
                db.add(SqlConversationLabel(conversation_id=cid, key=k, value=v, updated_at=1))
            for i, role in enumerate(["user", "assistant", "user"]):
                db.add(
                    SqlConversationItem(
                        conversation_id=cid,
                        id=uuid.uuid4().hex,
                        response_id="r",
                        created_at=1000 + i,
                        position=i,
                        type=1,
                        status=1,
                        data=json.dumps({"role": role, "content": []}),
                        search_text="",
                    )
                )
        db.commit()
    assert notes.recent_user_messages(since=0) == {chat: [1000, 1002]}
    assert notes.recent_user_messages(since=1001) == {chat: [1002]}


@pytest.mark.asyncio
async def test_evening_finalize_runs_once(harness, monkeypatch) -> None:
    qm, notes, _prefs, started = harness
    _messages(notes, monkeypatch, _stamps(3))
    await qm.idle_due(now=NOON)
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
    qm, notes, prefs, started = harness
    prefs.prefs = OwnerPreferences(user_id="local", proactivity="off")
    monkeypatch.setattr("omnigent.runtime.get_memory_service", lambda: SimpleNamespace())
    notes.write_sections("local", "2026-10-04", {"talked_about": "- x"}, parent_session_id=SESSION)
    notes.claim_finalize("local", "2026-10-04")
    assert await qm.nightly_due(now=time.time() + 4000) == 0
    assert started == []


def test_daily_note_tools_are_granted_only_to_a_helper_of_a_super_chat() -> None:
    """The runner dispatches with the sub-agent marker label (``_tool_labels_for_session``)."""
    from omnigent.context.labels import (
        CONTEXT_MODE_LABEL,
        SUBAGENT_LABEL_KEY,
        SUPERSIDE_CHAT_MODE_VALUE,
    )
    from omnigent.runner import tool_dispatch
    from omnigent.spec.types import AgentSpec

    spec = AgentSpec(spec_version=1)
    chat = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
    helper = {**chat, SUBAGENT_LABEL_KEY: "1"}
    for name in ("daily_note_get", "daily_note_update"):
        assert (
            tool_dispatch._ungranted_tool_reason(name, spec, "claude-sdk", labels=helper) is None
        )
        assert tool_dispatch._ungranted_tool_reason(name, spec, "claude-sdk", labels=chat)
