"""SQLAlchemy-backed memory store."""

from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, new_id
from omnigent.nova.memory.entities import MemoryNote, MemoryRevision, NoteKind, Profile
from omnigent.nova.memory.store import MemoryStore
from omnigent.nova.memory.tables import (
    NOTE_KIND_CODE,
    NOTE_KIND_NAME,
    SqlMemoryNote,
    SqlMemoryProfile,
    SqlMemoryRevision,
)

# A note's content is persisted verbatim (compressed) and read back on every
# context turn, so an unbounded write is a storage/context-budget amplifier —
# not a correctness issue, since render_memory caps what any turn actually
# sees. 256 KiB comfortably fits any hand-written note with room to grow.
_CONTENT_MAX_BYTES = 256 * 1024

# revisions() reads the most recent history for one note. A person's own
# remember() calls could in principle grow this without bound, so the read
# is capped rather than unbounded — see docs/DATABASE_BEST_PRACTICES.md's
# bounded-read rule. Far above what any UI would ever page through.
_MAX_REVISIONS_RETURNED = 500


def _validate_timezone(timezone: str) -> None:
    """Raise ``INVALID_INPUT`` if *timezone* is not a valid IANA zone."""
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, KeyError, ValueError) as exc:
        raise OmnigentError(
            f"invalid timezone {timezone!r}: must be a valid IANA timezone name",
            code=ErrorCode.INVALID_INPUT,
        ) from exc


def _check_content_size(content: str) -> None:
    """Raise ``INVALID_INPUT`` if *content* exceeds :data:`_CONTENT_MAX_BYTES`."""
    size = len(content.encode("utf-8"))
    if size > _CONTENT_MAX_BYTES:
        raise OmnigentError(
            f"memory note too large ({size} bytes; max {_CONTENT_MAX_BYTES})",
            code=ErrorCode.INVALID_INPUT,
        )


def _to_note(row: SqlMemoryNote) -> MemoryNote:
    """Convert a :class:`SqlMemoryNote` ORM row to a :class:`MemoryNote`."""
    return MemoryNote(
        id=row.id,
        user_id=row.user_id,
        workspace_id=row.workspace_id,
        kind=NoteKind(NOTE_KIND_NAME[row.kind]),
        path=row.path,
        content=row.content,
        revision=row.revision,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_revision(row: SqlMemoryRevision) -> MemoryRevision:
    """Convert a :class:`SqlMemoryRevision` ORM row to a :class:`MemoryRevision`."""
    return MemoryRevision(
        note_id=row.note_id,
        revision=row.revision,
        content=row.content,
        created_at=row.created_at,
    )


def _to_profile(actor: NovaActor, row: SqlMemoryProfile | None) -> Profile:
    """Convert a :class:`SqlMemoryProfile` ORM row (or its absence) to a :class:`Profile`."""
    if row is None:
        return Profile(
            user_id=actor.user_id,
            workspace_id=actor.workspace_id,
            timezone="UTC",
            display_name=None,
            updated_at=0,
        )
    return Profile(
        user_id=row.user_id,
        workspace_id=row.workspace_id,
        timezone=row.timezone,
        display_name=row.display_name,
        updated_at=row.updated_at,
    )


class SqlAlchemyMemoryStore(MemoryStore):
    """SQLAlchemy-backed implementation of :class:`MemoryStore`.

    Every query is scoped by ``(workspace_id, user_id)`` from the caller's
    :class:`NovaActor`, taken as given rather than re-read from
    :func:`current_workspace_id` — a tool invocation resolves its actor
    outside FastAPI's request scope, where that ambient context var may not
    be bound, so the actor's own snapshot is the only value trusted here.
    """

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI,
            e.g. ``"sqlite:///omnigent.db"``.
        """
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.nova.memory_store",
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.nova.memory_store",
            immediate=True,
        )

    def list_notes(self, actor: NovaActor) -> list[MemoryNote]:
        """List the person's notes, newest-updated first."""
        with self._session("list_notes") as session:
            stmt = (
                select(SqlMemoryNote)
                .where(SqlMemoryNote.workspace_id == actor.workspace_id)
                .where(SqlMemoryNote.user_id == actor.user_id)
                .order_by(desc(SqlMemoryNote.updated_at), desc(SqlMemoryNote.id))
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_note(r) for r in rows]

    def get(self, actor: NovaActor, note_id: str) -> MemoryNote | None:
        """Return one of the person's notes by id, or ``None`` if not found/owned."""
        with self._session("select_note_by_id") as session:
            row = session.get(SqlMemoryNote, (actor.workspace_id, note_id))
            if row is None or row.user_id != actor.user_id:
                return None
            return _to_note(row)

    def save(self, actor: NovaActor, kind: NoteKind, path: str, content: str) -> MemoryNote:
        """Replace a note's content, atomically appending a new revision.

        Finds the person's note at ``(kind, path)`` inside the write
        transaction and either updates it (bumping ``revision``) or creates
        it at revision 1 — the sole find-or-create path, backed by
        ``uq_nova_memory_notes_identity`` so a concurrent double-create of
        the same ``(kind, path)`` cannot land twice.
        """
        _check_content_size(content)
        kind_code = NOTE_KIND_CODE[kind.value]
        now = now_epoch()

        def write(session: Session) -> MemoryNote:
            stmt = (
                select(SqlMemoryNote)
                .where(SqlMemoryNote.workspace_id == actor.workspace_id)
                .where(SqlMemoryNote.user_id == actor.user_id)
                .where(SqlMemoryNote.kind == kind_code)
                .where(SqlMemoryNote.path == path)
            )
            row = session.execute(stmt).scalar_one_or_none()
            if row is None:
                row = SqlMemoryNote(
                    workspace_id=actor.workspace_id,
                    id=new_id(),
                    user_id=actor.user_id,
                    kind=kind_code,
                    path=path,
                    content=content,
                    revision=1,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.content = content
                row.revision += 1
                row.updated_at = now
            session.flush()
            session.add(
                SqlMemoryRevision(
                    workspace_id=actor.workspace_id,
                    note_id=row.id,
                    revision=row.revision,
                    content=content,
                    created_at=now,
                )
            )
            session.flush()
            return _to_note(row)

        return run_write_transaction(self._session_immediate, "save_note", write)

    def revisions(self, actor: NovaActor, note_id: str) -> list[MemoryRevision]:
        """Return a note's revision history, newest first (capped, see module docstring)."""
        if self.get(actor, note_id) is None:
            return []
        with self._session("list_revisions") as session:
            stmt = (
                select(SqlMemoryRevision)
                .where(SqlMemoryRevision.workspace_id == actor.workspace_id)
                .where(SqlMemoryRevision.note_id == note_id)
                .order_by(desc(SqlMemoryRevision.revision))
                .limit(_MAX_REVISIONS_RETURNED)
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_revision(r) for r in rows]

    def get_profile(self, actor: NovaActor) -> Profile:
        """Return the person's profile, defaulting to an unset (UTC) one."""
        with self._session("select_profile") as session:
            row = session.get(SqlMemoryProfile, (actor.workspace_id, actor.user_id))
            return _to_profile(actor, row)

    def set_timezone(self, actor: NovaActor, timezone: str) -> Profile:
        """Set the person's IANA timezone, creating their profile if needed."""
        _validate_timezone(timezone)
        now = now_epoch()

        def write(session: Session) -> Profile:
            row = session.get(SqlMemoryProfile, (actor.workspace_id, actor.user_id))
            if row is None:
                row = SqlMemoryProfile(
                    workspace_id=actor.workspace_id,
                    user_id=actor.user_id,
                    timezone=timezone,
                    display_name=None,
                    created_at=now,
                    updated_at=now,
                )
                session.add(row)
            else:
                row.timezone = timezone
                row.updated_at = now
            session.flush()
            return _to_profile(actor, row)

        return run_write_transaction(self._session_immediate, "set_timezone", write)
