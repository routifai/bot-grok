"""SQLAlchemy tables for Nova's memory primitive.

Owned entirely by this primitive: no other module writes these tables, and no
database foreign key ties them to the rest of the schema (``docs/DATABASE_BEST_PRACTICES.md``).
"""

from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Index,
    Integer,
    SmallInteger,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from omnigent.db.compression import CompressedText
from omnigent.db.db_models import OmnigentBase, Uuid16, current_workspace_id

# Stable int codes for NoteKind, following the omnigent.db.enum_codecs
# convention (append-only, never renumbered) without joining that shared
# table — this enum belongs to this primitive alone.
NOTE_KIND_CODE: dict[str, int] = {"nova": 1, "about_you": 2}
NOTE_KIND_NAME: dict[int, str] = {code: name for name, code in NOTE_KIND_CODE.items()}


class SqlMemoryNote(OmnigentBase):
    """One person's note: current content plus its revision counter.

    See :class:`omnigent.nova.memory.entities.MemoryNote`. A person has at
    most one note per ``(kind, path)`` pair — enforced by the unique
    constraint below, and the single point every read/write goes through.

    :param workspace_id: Tenant partition; part of the primary key.
    :param id: Uuid16 primary key (bare 32-char hex in Python).
    :param user_id: The person the note belongs to.
    :param kind: :data:`NOTE_KIND_CODE` — 1=nova, 2=about_you.
    :param path: The note's path, e.g. ``"MEMORY.md"``.
    :param content: Current markdown content. Stored compressed
        (``CompressedText``); the store enforces a byte cap on every write —
        never SQL-filtered, so an opaque blob is fine here.
    :param revision: Current revision number, starting at 1.
    :param created_at: Unix epoch seconds at creation.
    :param updated_at: Unix epoch seconds of the last save.
    """

    __tablename__ = "nova_memory_notes"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    content: Mapped[str] = mapped_column(CompressedText, nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint("kind IN (1, 2)", name="ck_nova_memory_notes_kind"),
        # The natural key a note is looked up and upserted by (list_notes,
        # save's find-or-create). Also the sole uniqueness guard — see
        # SqlAlchemyMemoryStore.save.
        UniqueConstraint(
            "workspace_id", "user_id", "kind", "path", name="uq_nova_memory_notes_identity"
        ),
        # Recency listing: "this person's notes, newest first" is a pure
        # index scan with id as the pagination tie-breaker.
        Index("ix_nova_memory_notes_listing", "workspace_id", "user_id", "updated_at", "id"),
    )


class SqlMemoryRevision(OmnigentBase):
    """One append-only revision of a note's content.

    See :class:`omnigent.nova.memory.entities.MemoryRevision`. Rows are never
    updated or deleted, only inserted alongside the note row they snapshot.

    :param workspace_id: Tenant partition; part of the primary key.
    :param note_id: The note this revision belongs to (no DB foreign key,
        Rule R032; the relationship is immutable and enforced in the store).
    :param revision: This revision's number; the primary key's leading
        ``(workspace_id, note_id)`` prefix already bounds a per-note scan, so
        this both completes the key and gives a natural traversal order.
    :param content: The full content as of this revision (``CompressedText``,
        same byte cap as :class:`SqlMemoryNote.content`).
    :param created_at: Unix epoch seconds when this revision was written.
    """

    __tablename__ = "nova_memory_revisions"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    note_id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    content: Mapped[str] = mapped_column(CompressedText, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)


class SqlMemoryProfile(OmnigentBase):
    """A person's Nova profile: timezone and display name.

    See :class:`omnigent.nova.memory.entities.Profile`. One row per person,
    created on first :meth:`MemoryStore.set_timezone` call.

    :param workspace_id: Tenant partition; part of the primary key.
    :param user_id: The person this profile belongs to; the rest of the key.
    :param timezone: An IANA timezone name, validated by the store.
    :param display_name: The person's display name, or ``NULL`` if unset.
    :param created_at: Unix epoch seconds when the profile was first saved.
    :param updated_at: Unix epoch seconds of the last save.
    """

    __tablename__ = "nova_memory_profiles"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    user_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)
