"""Tests for :class:`SqlAlchemyTaughtSkillStore`."""

from __future__ import annotations

import uuid

import pytest

from omnigent.superchat.skills.store import SqlAlchemyTaughtSkillStore

DOC = {"name": "Search", "steps": [{"intent": "Search"}]}


def _id() -> str:
    return uuid.uuid4().hex


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyTaughtSkillStore:
    return SqlAlchemyTaughtSkillStore(db_uri)


def _start(store: SqlAlchemyTaughtSkillStore, user: str | None = "alice"):
    session, rec, skill = _id(), _id(), _id()
    store.start_recording(rec, skill, user_id=user, session_id=session, goal="find shoes")
    return session, rec, skill


def test_recording_lifecycle_stores_trace_and_keyframes(store: SqlAlchemyTaughtSkillStore) -> None:
    session, rec, _skill = _start(store)
    assert store.active_recording(session, user_id="alice").id == rec  # type: ignore[union-attr]
    assert store.active_recording(session, user_id="bob") is None
    done = store.finish_recording(rec, actions=[{"seq": 1}], keyframes={"k2": b"b", "k10": b"a"})
    assert done is not None
    recording, sk = done
    assert recording.status == "stopped" and recording.actions == [{"seq": 1}]
    assert sk.status == "drafting" and sk.stopped_at is not None
    assert store.active_recording(session, user_id="alice") is None
    assert store.keyframe_names(rec) == ["k2", "k10"]
    assert store.keyframe(rec, "k2") == b"b"
    assert store.finish_recording(rec, actions=[], keyframes={}) is None


def test_save_doc_versions_and_status_rules(store: SqlAlchemyTaughtSkillStore) -> None:
    _session, rec, skill = _start(store)
    assert store.save_doc(skill, user_id="alice", doc=DOC) is None  # still recording
    store.finish_recording(rec, actions=[], keyframes={})
    first = store.save_doc(skill, user_id="alice", doc=DOC)
    assert first is not None and first.status == "draft" and first.version == 1
    assert first.name == "Search" and first.doc == DOC
    store.set_status(skill, user_id="alice", status="saved")
    edited = store.save_doc(skill, user_id="alice", doc={**DOC, "name": "Search shop"})
    assert edited is not None and edited.status == "saved" and edited.version == 2
    assert store.versions(skill) == [1, 2]
    assert store.save_doc(skill, user_id="bob", doc=DOC) is None


def test_list_is_owner_and_session_scoped(store: SqlAlchemyTaughtSkillStore) -> None:
    session, _rec, skill = _start(store)
    _start(store, user="bob")
    assert [s.id for s in store.list_skills(user_id="alice", parent_session_id=session)] == [skill]
    assert store.list_skills(user_id="alice", status="saved") == []
    assert store.get_skill(skill, user_id="bob") is None


def test_fail_recording_and_delete_remove_everything(store: SqlAlchemyTaughtSkillStore) -> None:
    _session, rec, skill = _start(store)
    store.fail_recording(rec)
    assert store.get_skill(skill, user_id="alice").status == "failed"  # type: ignore[union-attr]
    _s2, rec2, skill2 = _start(store)
    store.finish_recording(rec2, actions=[], keyframes={"k1": b"x"})
    assert store.delete_skill(skill2, user_id="bob") is False
    assert store.delete_skill(skill2, user_id="alice") is True
    assert store.get_skill(skill2, user_id="alice") is None
    assert store.keyframe(rec2, "k1") is None and store.get_recording(rec2) is None
