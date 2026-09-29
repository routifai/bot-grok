"""Tests for :mod:`omnigent.nova.memory.service`.

``remember`` and ``render_memory`` are pure enough to test against a fake
:class:`MemoryStore`, so these don't touch a database.
"""

from __future__ import annotations

from omnigent.nova._shared import NovaActor
from omnigent.nova.memory.entities import MemoryNote, MemoryRevision, NoteKind, Profile
from omnigent.nova.memory.service import DEFAULT_PATH, remember, render_memory
from omnigent.nova.memory.store import MemoryStore

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)


class FakeMemoryStore(MemoryStore):
    """An in-memory :class:`MemoryStore` for testing service-layer logic."""

    def __init__(self) -> None:
        super().__init__("fake://")
        self._notes: dict[str, MemoryNote] = {}
        self._next_id = 0

    def list_notes(self, actor: NovaActor) -> list[MemoryNote]:
        return [n for n in self._notes.values() if n.user_id == actor.user_id]

    def get(self, actor: NovaActor, note_id: str) -> MemoryNote | None:
        note = self._notes.get(note_id)
        return note if note is not None and note.user_id == actor.user_id else None

    def save(self, actor: NovaActor, kind: NoteKind, path: str, content: str) -> MemoryNote:
        existing = next(
            (n for n in self.list_notes(actor) if n.kind == kind and n.path == path), None
        )
        if existing is None:
            self._next_id += 1
            note = MemoryNote(
                id=f"note-{self._next_id}",
                user_id=actor.user_id,
                workspace_id=actor.workspace_id,
                kind=kind,
                path=path,
                content=content,
                revision=1,
                created_at=0,
                updated_at=0,
            )
        else:
            note = MemoryNote(
                id=existing.id,
                user_id=existing.user_id,
                workspace_id=existing.workspace_id,
                kind=existing.kind,
                path=existing.path,
                content=content,
                revision=existing.revision + 1,
                created_at=existing.created_at,
                updated_at=existing.updated_at + 1,
            )
        self._notes[note.id] = note
        return note

    def revisions(self, actor: NovaActor, note_id: str) -> list[MemoryRevision]:
        raise NotImplementedError  # pragma: no cover - unused in these tests

    def get_profile(self, actor: NovaActor) -> Profile:
        raise NotImplementedError  # pragma: no cover - unused in these tests

    def set_timezone(self, actor: NovaActor, timezone: str) -> Profile:
        raise NotImplementedError  # pragma: no cover - unused in these tests


# ── remember ─────────────────────────────────────────────────────────────


def test_remember_creates_a_note_when_missing() -> None:
    store = FakeMemoryStore()
    note = remember(ACTOR, "Likes tea.", NoteKind.ABOUT_YOU, store=store)
    assert note.content == "Likes tea."
    assert note.revision == 1


def test_remember_appends_as_a_new_paragraph() -> None:
    store = FakeMemoryStore()
    remember(ACTOR, "Likes tea.", NoteKind.ABOUT_YOU, store=store)
    note = remember(ACTOR, "Likes dark mode.", NoteKind.ABOUT_YOU, store=store)
    assert note.content == "Likes tea.\n\nLikes dark mode."
    assert note.revision == 2


def test_remember_strips_whitespace_from_the_addition() -> None:
    store = FakeMemoryStore()
    note = remember(ACTOR, "  Likes tea.  \n", NoteKind.ABOUT_YOU, store=store)
    assert note.content == "Likes tea."


def test_remember_defaults_to_memory_md() -> None:
    store = FakeMemoryStore()
    note = remember(ACTOR, "fact", NoteKind.NOVA, store=store)
    assert note.path == DEFAULT_PATH


def test_remember_kinds_and_paths_do_not_cross_contaminate() -> None:
    store = FakeMemoryStore()
    remember(ACTOR, "about them", NoteKind.ABOUT_YOU, store=store)
    nova_note = remember(ACTOR, "nova's own note", NoteKind.NOVA, store=store)
    assert nova_note.content == "nova's own note"


# ── render_memory ────────────────────────────────────────────────────────


def _note(
    kind: NoteKind, path: str, content: str, *, revision: int = 1, updated_at: int = 0
) -> MemoryNote:
    return MemoryNote(
        id=f"{kind}-{path}",
        user_id=ACTOR.user_id,
        workspace_id=ACTOR.workspace_id,
        kind=kind,
        path=path,
        content=content,
        revision=revision,
        created_at=updated_at,
        updated_at=updated_at,
    )


def test_render_memory_empty_notes_is_empty_string() -> None:
    assert render_memory([], 1000) == ""


def test_render_memory_includes_heading_with_kind_path_and_revision() -> None:
    note = _note(NoteKind.ABOUT_YOU, "MEMORY.md", "Likes tea.", revision=3)
    rendered = render_memory([note], 1000)
    assert rendered == "## about_you: MEMORY.md (revision 3)\nLikes tea."


def test_render_memory_orders_newest_updated_first() -> None:
    older = _note(NoteKind.NOVA, "MEMORY.md", "older", updated_at=1)
    newer = _note(NoteKind.ABOUT_YOU, "MEMORY.md", "newer", updated_at=2)
    rendered = render_memory([older, newer], 1000)
    assert rendered.index("newer") < rendered.index("older")


def test_render_memory_drops_a_note_that_would_split_its_heading() -> None:
    note = _note(NoteKind.ABOUT_YOU, "MEMORY.md", "content")
    heading = f"## {note.kind}: {note.path} (revision {note.revision})\n"
    too_small = len(heading.encode("utf-8")) - 1
    assert render_memory([note], too_small) == ""


def test_render_memory_truncates_content_and_stops() -> None:
    first = _note(NoteKind.ABOUT_YOU, "MEMORY.md", "a" * 100, updated_at=2)
    second = _note(NoteKind.NOVA, "MEMORY.md", "b" * 100, updated_at=1)
    heading = f"## {first.kind}: {first.path} (revision {first.revision})\n"
    budget = len(heading.encode("utf-8")) + 10  # room for the heading + a few bytes of content
    rendered = render_memory([first, second], budget)
    assert "b" * 100 not in rendered  # the second note never got a chance
    assert len(rendered.encode("utf-8")) <= budget


def test_render_memory_never_exceeds_budget() -> None:
    notes = [_note(NoteKind.ABOUT_YOU, f"note-{i}.md", "x" * 50, updated_at=i) for i in range(5)]
    rendered = render_memory(notes, 120)
    assert len(rendered.encode("utf-8")) <= 120
