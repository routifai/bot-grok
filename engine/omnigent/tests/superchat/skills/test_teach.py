"""Tests for distilling a recording into a draft: the teacher's brief and failure handling."""

from __future__ import annotations

import base64
import uuid
from typing import Any

import pytest

from omnigent.superchat.taught_skills import teach
from omnigent.superchat.taught_skills.store import SqlAlchemyTaughtSkillStore

pytestmark = pytest.mark.asyncio


def _stopped(store: SqlAlchemyTaughtSkillStore):
    session, rec, skill = (uuid.uuid4().hex for _ in range(3))
    store.start_recording(rec, skill, user_id="alice", session_id=session, goal="search shoes")
    actions = [
        {"seq": 1, "kind": "navigate", "url": "https://shop.example/", "keyframe": "k1"},
        {"seq": 2, "kind": "secret", "role": "textbox", "name": "Password"},
    ]
    recording, row = store.finish_recording(rec, actions=actions, keyframes={"k1": b"jpeg"})  # type: ignore[misc]
    return recording, row


async def test_distill_sends_brief_and_keyframes_to_the_teacher(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SqlAlchemyTaughtSkillStore(db_uri)
    recording, skill = _stopped(store)
    sent: dict[str, Any] = {}

    async def fake_start(deps: object, **kwargs: Any) -> str:
        sent.update(kwargs)
        return "child"

    monkeypatch.setattr(teach, "start_adhoc_helper", fake_start)
    await teach.distill(store, object(), skill, recording)  # type: ignore[arg-type]
    assert sent["agent_type"] == "teacher" and sent["parent_session_id"] == skill.parent_session_id
    text, *rest = sent["content"]
    assert f"skill_id: {skill.id}" in text["text"] and "typed a secret" in text["text"]
    image = next(block for block in rest if block["type"] == "input_image")
    assert image["image_url"] == "data:image/jpeg;base64," + base64.b64encode(b"jpeg").decode()
    assert store.get_skill(skill.id, user_id="alice").status == "drafting"  # type: ignore[union-attr]


async def test_distill_failure_marks_the_skill_failed(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SqlAlchemyTaughtSkillStore(db_uri)
    recording, skill = _stopped(store)

    async def boom(deps: object, **kwargs: Any) -> str:
        raise RuntimeError("no runner")

    monkeypatch.setattr(teach, "start_adhoc_helper", boom)
    await teach.distill(store, object(), skill, recording)  # type: ignore[arg-type]
    assert store.get_skill(skill.id, user_id="alice").status == "failed"  # type: ignore[union-attr]


async def test_a_draft_that_never_arrives_expires(db_uri: str) -> None:
    store = SqlAlchemyTaughtSkillStore(db_uri)
    _recording, skill = _stopped(store)
    assert skill.stopped_at is not None
    assert teach.expire_stale_draft(store, skill, skill.stopped_at + 10).status == "drafting"
    late = skill.stopped_at + teach.DRAFTING_TIMEOUT_S + 1
    assert teach.expire_stale_draft(store, skill, late).status == "failed"
