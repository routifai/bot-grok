"""Domain logic for Nova's memory: remembering facts and rendering context."""

from __future__ import annotations

from collections.abc import Iterable

from omnigent.nova._shared import NovaActor, cap_utf8
from omnigent.nova.memory.entities import MemoryNote, NoteKind
from omnigent.nova.memory.store import MemoryStore

# Every note defaults here unless a caller names a different path — mirrors
# the TypeScript port's ``MEMORY.md`` default (packages/adapters/src/builtin-tools.ts).
DEFAULT_PATH = "MEMORY.md"


def remember(
    actor: NovaActor,
    content: str,
    kind: NoteKind,
    path: str = DEFAULT_PATH,
    *,
    store: MemoryStore,
) -> MemoryNote:
    """Append a line or paragraph to a note, creating it when missing.

    Unlike the store's own :meth:`MemoryStore.save` (a full replace), this is
    Nova's "remember this" behaviour: the new text is added as its own
    paragraph after whatever the note already says. The read of the current
    content happens outside ``save``'s write transaction — a concurrent
    ``remember`` call could race and one addition could be lost — the same
    accepted tradeoff as ``SqlAlchemyProjectStore``'s name-uniqueness check;
    a person's own memory sees at most one writer at a time in practice.

    :param actor: The person the note belongs to.
    :param content: The fact to remember; leading/trailing whitespace is
        trimmed.
    :param kind: Which note to append to.
    :param path: The note's path; almost always the default.
    :param store: Where to read the current content from and save the result.
    :returns: The note after the append.
    """
    existing = _find(store.list_notes(actor), kind, path)
    merged = _append(existing.content if existing is not None else "", content)
    return store.save(actor, kind, path, merged)


def _find(notes: Iterable[MemoryNote], kind: NoteKind, path: str) -> MemoryNote | None:
    """Return the note matching ``(kind, path)``, or ``None``."""
    return next((note for note in notes if note.kind == kind and note.path == path), None)


def _append(existing: str, addition: str) -> str:
    """Join ``addition`` onto ``existing`` as a new paragraph.

    :param existing: The note's current content, or ``""`` when it has none.
    :param addition: The text being remembered.
    :returns: The note's new full content.
    """
    addition = addition.strip()
    return addition if not existing.strip() else f"{existing.rstrip()}\n\n{addition}"


def render_memory(notes: Iterable[MemoryNote], max_bytes: int) -> str:
    """Render notes into context text: newest first, one heading per note.

    Ports ``loadAgentMemoryContext`` (packages/adapters/src/memory-context.ts):
    notes are ordered newest-first (by ``updated_at``, then ``revision``, then
    ``kind``/``path`` to break ties deterministically); each gets a
    ``## <kind>: <path> (revision N)`` heading; a heading is never split — a
    note that would not fit even its heading is dropped entirely — and the
    note whose content had to be truncated to fit is the last one rendered.
    Unlike the TypeScript version, this returns only the notes themselves;
    the surrounding preamble and tag are added by ``context/composer.py``.

    :param notes: The person's notes, in any order.
    :param max_bytes: The UTF-8 budget for the returned text.
    :returns: The rendered text; ``""`` when *notes* is empty or the budget
        cannot fit even one heading.
    """
    ordered = sorted(
        notes,
        key=lambda note: (-note.updated_at, -note.revision, str(note.kind), note.path),
    )
    sections: list[str] = []
    remaining = max_bytes
    for note in ordered:
        if remaining <= 0:
            break
        separator = "\n\n" if sections else ""
        heading = f"{separator}## {note.kind}: {note.path} (revision {note.revision})\n"
        heading_bytes = len(heading.encode("utf-8"))
        if heading_bytes > remaining:
            break
        sections.append(heading)
        remaining -= heading_bytes

        body = cap_utf8(note.content, remaining)
        sections.append(body)
        remaining -= len(body.encode("utf-8"))
        if body != note.content:
            break  # This note was truncated; nothing more will fit after it.

    return "".join(sections)
