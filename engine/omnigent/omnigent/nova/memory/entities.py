"""Domain types for Nova's memory: notes, their revisions, and a person's profile."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class NoteKind(StrEnum):
    """Which of a person's two notes this is.

    :cvar NOVA: Nova's own notes to itself ("My notes" in the UI).
    :cvar ABOUT_YOU: What Nova knows about the person ("About you" in the UI).
    """

    NOVA = "nova"
    ABOUT_YOU = "about_you"


@dataclass(frozen=True)
class MemoryNote:
    """One markdown document Nova keeps for a person, with its current content.

    :param id: Opaque 32-char hex id.
    :param user_id: The person the note belongs to (a :class:`NovaActor`'s
        ``user_id``); Nova keeps one assistant per person, so every note is
        keyed by the person, never a bot.
    :param workspace_id: Omnigent workspace the note lives in.
    :param kind: Which note this is.
    :param path: The note's path within the person's memory, e.g. ``"MEMORY.md"``.
    :param content: The note's current markdown content.
    :param revision: The current revision number, starting at 1.
    :param created_at: Unix epoch seconds when the note was first created.
    :param updated_at: Unix epoch seconds of the last save.
    """

    id: str
    user_id: str
    workspace_id: int
    kind: NoteKind
    path: str
    content: str
    revision: int
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class MemoryRevision:
    """One entry in a note's append-only revision history.

    :param note_id: The note this revision belongs to.
    :param revision: This revision's number.
    :param content: The full content as of this revision.
    :param created_at: Unix epoch seconds when this revision was written.
    """

    note_id: str
    revision: int
    content: str
    created_at: int


@dataclass(frozen=True)
class Profile:
    """A person's Nova profile: the few facts context needs about them directly.

    :param user_id: The person this profile belongs to.
    :param workspace_id: Omnigent workspace the profile lives in.
    :param timezone: An IANA timezone name, e.g. ``"America/Toronto"``.
        Defaults to ``"UTC"`` until the person sets one.
    :param display_name: The person's display name, or ``None`` if unset.
    :param updated_at: Unix epoch seconds of the last update, or ``0`` when
        the profile has never been saved (a default, unpersisted view).
    """

    user_id: str
    workspace_id: int
    timezone: str
    display_name: str | None
    updated_at: int
