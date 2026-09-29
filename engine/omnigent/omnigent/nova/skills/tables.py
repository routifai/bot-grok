"""SQLAlchemy tables for Nova's skills primitive: saved skills and their offers.

Owned entirely by this primitive (docs/DATABASE_BEST_PRACTICES.md): no other
module writes these tables, and no database foreign key ties them to the rest
of the schema.
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

# Stable int codes for OfferStatus, append-only like NOTE_KIND_CODE
# (omnigent/nova/memory/tables.py) — local to this primitive's own table.
OFFER_STATUS_CODE: dict[str, int] = {"open": 1, "saved": 2, "dismissed": 3}
OFFER_STATUS_NAME: dict[int, str] = {code: name for name, code in OFFER_STATUS_CODE.items()}

# Same append-only convention for OfferKind.
OFFER_KIND_CODE: dict[str, int] = {"new": 1, "update": 2}
OFFER_KIND_NAME: dict[int, str] = {code: name for name, code in OFFER_KIND_CODE.items()}

# Bounds mirror the TypeScript prototype's limits (agent-skill.ts): a name is
# a short label, a description one line, comfortably under the 16 KiB column cap.
_NAME_MAX = 80
_DESCRIPTION_MAX = 2_000


class SqlSkill(OmnigentBase):
    """One skill a person has saved.

    See :class:`omnigent.nova.skills.entities.Skill`. Unique per person on
    ``name`` — the natural key routes and tools address a skill by.

    :param workspace_id: Tenant partition; part of the primary key.
    :param id: Uuid16 primary key (bare 32-char hex in Python).
    :param user_id: The person the skill belongs to.
    :param name: Short name, bounded to ``_NAME_MAX``.
    :param description: One-line description, bounded to ``_DESCRIPTION_MAX``.
    :param content: The full ``SKILL.md`` text. Stored compressed
        (``CompressedText``); the service enforces a character cap on every
        write — never SQL-filtered, so an opaque blob is fine here.
    :param created_at: Unix epoch seconds at creation.
    :param updated_at: Unix epoch seconds of the last save.
    """

    __tablename__ = "nova_skills"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(_NAME_MAX), nullable=False)
    description: Mapped[str] = mapped_column(String(_DESCRIPTION_MAX), nullable=False)
    content: Mapped[str] = mapped_column(CompressedText, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        # The natural key a skill is looked up, listed and deleted by — also
        # the sole uniqueness guard (see SqlAlchemySkillStore.create_skill).
        UniqueConstraint("workspace_id", "user_id", "name", name="uq_nova_skills_identity"),
    )


class SqlSkillOffer(OmnigentBase):
    """One pending or decided offer to save a skill.

    See :class:`omnigent.nova.skills.entities.SkillOffer`.

    :param workspace_id: Tenant partition; part of the primary key.
    :param id: Uuid16 primary key.
    :param user_id: The person being offered the skill.
    :param name: The proposed skill's name, bounded to ``_NAME_MAX``.
    :param description: One-line description, bounded to ``_DESCRIPTION_MAX``.
    :param content: The full proposed ``SKILL.md`` text (``CompressedText``,
        same cap as :class:`SqlSkill.content`).
    :param status: :data:`OFFER_STATUS_CODE` — 1=open, 2=saved, 3=dismissed.
    :param created_at: Unix epoch seconds when offered.
    :param decided_at: Unix epoch seconds decided, or ``NULL`` while open.
    :param offer_kind: :data:`OFFER_KIND_CODE` — 1=new, 2=update.
    :param target_skill: The existing skill's name this offer would update
        (``offer_kind=2``), or ``NULL`` for a new skill.
    """

    __tablename__ = "nova_skill_offers"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(_NAME_MAX), nullable=False)
    description: Mapped[str] = mapped_column(String(_DESCRIPTION_MAX), nullable=False)
    content: Mapped[str] = mapped_column(CompressedText, nullable=False)
    status: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    decided_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
    offer_kind: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, server_default="1", default=1
    )
    target_skill: Mapped[str | None] = mapped_column(String(_NAME_MAX), nullable=True)

    __table_args__ = (
        CheckConstraint("status IN (1, 2, 3)", name="ck_nova_skill_offers_status"),
        CheckConstraint("offer_kind IN (1, 2)", name="ck_nova_skill_offers_kind"),
        # "Waiting on you": open offers for a person, newest first — mirrors
        # nova_asks' ix_nova_asks_open (created_at/id trail for a backward
        # index scan rather than a descending index).
        Index(
            "ix_nova_skill_offers_open",
            "workspace_id",
            "user_id",
            "status",
            "created_at",
            "id",
        ),
        # Duplicate-name / no-repeat check: an open or dismissed offer with
        # this name blocks a new one (SkillService.offer).
        Index(
            "ix_nova_skill_offers_name",
            "workspace_id",
            "user_id",
            "name",
            "status",
        ),
    )
