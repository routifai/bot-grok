"""Tests for :class:`SqlAlchemyMemoryStore`.

Exercises notes, revisions, and the profile against a real SQLite database
(the ``db_uri`` fixture other store tests use), covering owner scoping,
find-or-create on ``save``, and timezone validation.
"""

from __future__ import annotations

import pytest

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor
from omnigent.nova.memory.entities import NoteKind
from omnigent.nova.memory.sqlalchemy_store import SqlAlchemyMemoryStore

ALICE = NovaActor(user_id="alice@example.com", workspace_id=0)
BOB = NovaActor(user_id="bob@example.com", workspace_id=0)


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyMemoryStore:
    """A fresh :class:`SqlAlchemyMemoryStore` backed by the test SQLite DB."""
    return SqlAlchemyMemoryStore(db_uri)


# ── save / list / get ───────────────────────────────────────────────────────


def test_save_creates_a_note_at_revision_one(store: SqlAlchemyMemoryStore) -> None:
    note = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "Likes tea.")
    assert note.content == "Likes tea."
    assert note.revision == 1
    assert note.user_id == ALICE.user_id
    assert note.kind is NoteKind.ABOUT_YOU
    assert note.created_at == note.updated_at


def test_save_again_replaces_content_and_bumps_revision(store: SqlAlchemyMemoryStore) -> None:
    first = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "Likes tea.")
    second = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "Likes coffee.")
    assert second.id == first.id
    assert second.content == "Likes coffee."
    assert second.revision == 2


def test_save_is_scoped_by_kind_and_path(store: SqlAlchemyMemoryStore) -> None:
    """Different kinds or paths are different notes, not the same row."""
    about_you = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "a")
    nova = store.save(ALICE, NoteKind.NOVA, "MEMORY.md", "b")
    other_path = store.save(ALICE, NoteKind.ABOUT_YOU, "notes/other.md", "c")
    assert len({about_you.id, nova.id, other_path.id}) == 3


def test_list_notes_scoped_to_owner(store: SqlAlchemyMemoryStore) -> None:
    store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "alice's note")
    store.save(BOB, NoteKind.ABOUT_YOU, "MEMORY.md", "bob's note")
    alice_notes = store.list_notes(ALICE)
    assert [n.content for n in alice_notes] == ["alice's note"]


def test_list_notes_newest_updated_first(
    store: SqlAlchemyMemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # now_epoch() has 1-second resolution; three saves in a row can tie, so
    # the clock is stepped explicitly to make ordering deterministic.
    clock = iter([1, 2, 3])
    monkeypatch.setattr("omnigent.nova.memory.sqlalchemy_store.now_epoch", lambda: next(clock))

    store.save(ALICE, NoteKind.NOVA, "MEMORY.md", "first")
    store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "second")
    store.save(ALICE, NoteKind.NOVA, "MEMORY.md", "first, updated")
    notes = store.list_notes(ALICE)
    assert notes[0].content == "first, updated"


def test_get_returns_none_for_missing_note(store: SqlAlchemyMemoryStore) -> None:
    assert store.get(ALICE, "0" * 32) is None


def test_get_returns_none_for_someone_elses_note(store: SqlAlchemyMemoryStore) -> None:
    note = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "alice's note")
    assert store.get(BOB, note.id) is None


def test_get_returns_owned_note(store: SqlAlchemyMemoryStore) -> None:
    note = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "alice's note")
    got = store.get(ALICE, note.id)
    assert got is not None
    assert got.content == "alice's note"


def test_save_rejects_oversized_content(store: SqlAlchemyMemoryStore) -> None:
    huge = "x" * (256 * 1024 + 1)
    with pytest.raises(OmnigentError) as excinfo:
        store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", huge)
    assert excinfo.value.code == ErrorCode.INVALID_INPUT


# ── revisions ───────────────────────────────────────────────────────────────


def test_revisions_newest_first(store: SqlAlchemyMemoryStore) -> None:
    note = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "v1")
    store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "v2")
    revisions = store.revisions(ALICE, note.id)
    assert [r.content for r in revisions] == ["v2", "v1"]
    assert [r.revision for r in revisions] == [2, 1]


def test_revisions_empty_for_missing_or_unowned_note(store: SqlAlchemyMemoryStore) -> None:
    assert store.revisions(ALICE, "0" * 32) == []
    note = store.save(ALICE, NoteKind.ABOUT_YOU, "MEMORY.md", "v1")
    assert store.revisions(BOB, note.id) == []


# ── profile ───────────────────────────────────────────────────────────────


def test_get_profile_defaults_to_utc_without_writing(store: SqlAlchemyMemoryStore) -> None:
    profile = store.get_profile(ALICE)
    assert profile.timezone == "UTC"
    assert profile.display_name is None
    assert profile.updated_at == 0
    # Reading twice must not have created a row.
    assert store.get_profile(ALICE) == profile


def test_set_timezone_persists(store: SqlAlchemyMemoryStore) -> None:
    updated = store.set_timezone(ALICE, "America/Toronto")
    assert updated.timezone == "America/Toronto"
    assert store.get_profile(ALICE).timezone == "America/Toronto"


def test_set_timezone_rejects_invalid_zone(store: SqlAlchemyMemoryStore) -> None:
    with pytest.raises(OmnigentError) as excinfo:
        store.set_timezone(ALICE, "Not/AZone")
    assert excinfo.value.code == ErrorCode.INVALID_INPUT


def test_profile_scoped_by_owner(store: SqlAlchemyMemoryStore) -> None:
    store.set_timezone(ALICE, "America/Toronto")
    assert store.get_profile(BOB).timezone == "UTC"
