"""The memory store interface: notes, their revisions, and a person's profile."""

from __future__ import annotations

from abc import ABC, abstractmethod

from omnigent.nova._shared import NovaActor
from omnigent.nova.memory.entities import MemoryNote, MemoryRevision, NoteKind, Profile


class MemoryStore(ABC):
    """Abstract base for Nova's memory persistence.

    Every method is scoped by the actor's ``(workspace_id, user_id)`` — a
    person only ever sees and mutates their own notes and profile.
    """

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI, e.g.
            ``"sqlite:///omnigent.db"``.
        """
        self.storage_location = storage_location

    @abstractmethod
    def list_notes(self, actor: NovaActor) -> list[MemoryNote]:
        """
        Return the person's notes, newest-updated first.

        :param actor: Whose notes to list.
        :returns: The person's notes; empty when they have none yet.
        """
        ...

    @abstractmethod
    def get(self, actor: NovaActor, note_id: str) -> MemoryNote | None:
        """
        Return one of the person's notes by id, or ``None`` if not found.

        :param actor: The requesting person; a note owned by someone else is
            treated as not found.
        :param note_id: Opaque note id.
        :returns: The :class:`MemoryNote` if found and owned, else ``None``.
        """
        ...

    @abstractmethod
    def save(self, actor: NovaActor, kind: NoteKind, path: str, content: str) -> MemoryNote:
        """
        Replace a note's content, atomically appending a new revision.

        Creates the note (starting at revision 1) if the person has no note
        at ``(kind, path)`` yet.

        :param actor: Whose note to save.
        :param kind: Which note this is.
        :param path: The note's path, e.g. ``"MEMORY.md"``.
        :param content: The note's new full content.
        :returns: The saved :class:`MemoryNote`.
        :raises OmnigentError: ``INVALID_INPUT`` if *content* exceeds the
            store's size cap.
        """
        ...

    @abstractmethod
    def revisions(self, actor: NovaActor, note_id: str) -> list[MemoryRevision]:
        """
        Return a note's revision history, newest first.

        :param actor: The requesting person.
        :param note_id: The note to list revisions for.
        :returns: The note's revisions, most recent first; empty if the note
            does not exist or is not owned by *actor*.
        """
        ...

    @abstractmethod
    def get_profile(self, actor: NovaActor) -> Profile:
        """
        Return the person's Nova profile, defaulting to an unset one.

        Never writes: a person who has never set a timezone gets back a
        transient ``Profile(timezone="UTC", display_name=None, updated_at=0)``
        rather than a row being created on their behalf.

        :param actor: Whose profile to read.
        :returns: The stored profile, or the default view.
        """
        ...

    @abstractmethod
    def set_timezone(self, actor: NovaActor, timezone: str) -> Profile:
        """
        Set the person's IANA timezone, creating their profile if needed.

        :param actor: Whose profile to update.
        :param timezone: An IANA timezone name, e.g. ``"America/Toronto"``.
        :returns: The updated profile.
        :raises OmnigentError: ``INVALID_INPUT`` if *timezone* is not a valid
            IANA zone.
        """
        ...
