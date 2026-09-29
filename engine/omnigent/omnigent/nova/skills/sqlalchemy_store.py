"""SQLAlchemy-backed skills store."""

from __future__ import annotations

from sqlalchemy import asc, desc, select
from sqlalchemy.orm import Session

from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.nova._shared import NovaActor
from omnigent.nova.skills.entities import OfferKind, OfferStatus, Skill, SkillOffer
from omnigent.nova.skills.store import SkillStore
from omnigent.nova.skills.tables import (
    OFFER_KIND_CODE,
    OFFER_KIND_NAME,
    OFFER_STATUS_CODE,
    OFFER_STATUS_NAME,
    SqlSkill,
    SqlSkillOffer,
)

# Offers that block re-offering the same name (SkillService.offer): still
# pending, or already declined — see SkillStore.find_blocking_offer.
_BLOCKING_STATUSES = (OfferStatus.OPEN, OfferStatus.DISMISSED)


def _to_skill(row: SqlSkill) -> Skill:
    """Convert a :class:`SqlSkill` ORM row to a :class:`Skill`."""
    return Skill(
        id=row.id,
        user_id=row.user_id,
        workspace_id=row.workspace_id,
        name=row.name,
        description=row.description,
        content=row.content,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_offer(row: SqlSkillOffer) -> SkillOffer:
    """Convert a :class:`SqlSkillOffer` ORM row to a :class:`SkillOffer`."""
    return SkillOffer(
        id=row.id,
        user_id=row.user_id,
        workspace_id=row.workspace_id,
        name=row.name,
        description=row.description,
        content=row.content,
        status=OfferStatus(OFFER_STATUS_NAME[row.status]),
        created_at=row.created_at,
        decided_at=row.decided_at,
        offer_kind=OfferKind(OFFER_KIND_NAME[row.offer_kind]),
        target_skill=row.target_skill,
    )


class SqlAlchemySkillStore(SkillStore):
    """SQLAlchemy-backed implementation of :class:`SkillStore`.

    Every query is scoped by ``(workspace_id, user_id)`` from the caller's
    :class:`NovaActor`, taken as given rather than re-read from
    :func:`current_workspace_id` — same rationale as
    ``SqlAlchemyMemoryStore`` (a tool invocation resolves its actor outside
    FastAPI's request scope, where that ambient context var may not be bound).
    """

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI,
            e.g. ``"sqlite:///omnigent.db"``.
        """
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova.skills_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.nova.skills_store",
            immediate=True,
        )

    # ── skills ───────────────────────────────────────────────────────────

    def list_skills(self, actor: NovaActor) -> list[Skill]:
        """List the person's skills, alphabetical by name."""
        with self._session("list_skills") as session:
            stmt = (
                select(SqlSkill)
                .where(SqlSkill.workspace_id == actor.workspace_id)
                .where(SqlSkill.user_id == actor.user_id)
                .order_by(asc(SqlSkill.name))
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_skill(r) for r in rows]

    def get_skill(self, actor: NovaActor, name: str) -> Skill | None:
        """Return one of the person's skills by exact name, or ``None``."""
        with self._session("select_skill_by_name") as session:
            stmt = (
                select(SqlSkill)
                .where(SqlSkill.workspace_id == actor.workspace_id)
                .where(SqlSkill.user_id == actor.user_id)
                .where(SqlSkill.name == name)
            )
            row = session.execute(stmt).scalar_one_or_none()
            return _to_skill(row) if row is not None else None

    def create_skill(
        self, skill_id: str, actor: NovaActor, *, name: str, description: str, content: str
    ) -> Skill:
        """Insert a new skill row."""
        now = now_epoch()

        def write(session: Session) -> Skill:
            row = SqlSkill(
                workspace_id=actor.workspace_id,
                id=skill_id,
                user_id=actor.user_id,
                name=name,
                description=description,
                content=content,
                created_at=now,
                updated_at=now,
            )
            session.add(row)
            session.flush()
            return _to_skill(row)

        return run_write_transaction(self._session_immediate, "create_skill", write)

    def delete_skill(self, actor: NovaActor, name: str) -> bool:
        """Delete a skill by name, scoped to the owner. Idempotent."""

        def write(session: Session) -> bool:
            stmt = (
                select(SqlSkill)
                .where(SqlSkill.workspace_id == actor.workspace_id)
                .where(SqlSkill.user_id == actor.user_id)
                .where(SqlSkill.name == name)
            )
            row = session.execute(stmt).scalar_one_or_none()
            if row is None:
                return False
            session.delete(row)
            return True

        return run_write_transaction(self._session_immediate, "delete_skill", write)

    def update_skill(
        self, actor: NovaActor, name: str, *, description: str, content: str
    ) -> Skill | None:
        """Replace a skill's description/content in place, scoped to the owner."""

        def write(session: Session) -> Skill | None:
            stmt = (
                select(SqlSkill)
                .where(SqlSkill.workspace_id == actor.workspace_id)
                .where(SqlSkill.user_id == actor.user_id)
                .where(SqlSkill.name == name)
            )
            row = session.execute(stmt).scalar_one_or_none()
            if row is None:
                return None
            row.description = description
            row.content = content
            row.updated_at = now_epoch()
            session.flush()
            return _to_skill(row)

        return run_write_transaction(self._session_immediate, "update_skill", write)

    # ── offers ───────────────────────────────────────────────────────────

    def list_open_offers(self, actor: NovaActor) -> list[SkillOffer]:
        """List the person's open offers, newest first."""
        with self._session("list_open_offers") as session:
            stmt = (
                select(SqlSkillOffer)
                .where(SqlSkillOffer.workspace_id == actor.workspace_id)
                .where(SqlSkillOffer.user_id == actor.user_id)
                .where(SqlSkillOffer.status == OFFER_STATUS_CODE[OfferStatus.OPEN.value])
                .order_by(desc(SqlSkillOffer.created_at), desc(SqlSkillOffer.id))
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_offer(r) for r in rows]

    def get_offer(self, actor: NovaActor, offer_id: str) -> SkillOffer | None:
        """Return one of the person's offers by id, or ``None`` if not found/owned."""
        with self._session("select_offer_by_id") as session:
            row = session.get(SqlSkillOffer, (actor.workspace_id, offer_id))
            if row is None or row.user_id != actor.user_id:
                return None
            return _to_offer(row)

    def find_blocking_offer(self, actor: NovaActor, name: str) -> SkillOffer | None:
        """Find an existing open or dismissed offer with this name, if any."""
        codes = [OFFER_STATUS_CODE[status.value] for status in _BLOCKING_STATUSES]
        with self._session("select_blocking_offer") as session:
            stmt = (
                select(SqlSkillOffer)
                .where(SqlSkillOffer.workspace_id == actor.workspace_id)
                .where(SqlSkillOffer.user_id == actor.user_id)
                .where(SqlSkillOffer.name == name)
                .where(SqlSkillOffer.status.in_(codes))
            )
            row = session.execute(stmt).scalar_one_or_none()
            return _to_offer(row) if row is not None else None

    def create_offer(
        self,
        offer_id: str,
        actor: NovaActor,
        *,
        name: str,
        description: str,
        content: str,
        offer_kind: OfferKind = OfferKind.NEW,
        target_skill: str | None = None,
    ) -> SkillOffer:
        """Insert a new open offer."""
        now = now_epoch()

        def write(session: Session) -> SkillOffer:
            row = SqlSkillOffer(
                workspace_id=actor.workspace_id,
                id=offer_id,
                user_id=actor.user_id,
                name=name,
                description=description,
                content=content,
                status=OFFER_STATUS_CODE[OfferStatus.OPEN.value],
                created_at=now,
                decided_at=None,
                offer_kind=OFFER_KIND_CODE[offer_kind.value],
                target_skill=target_skill,
            )
            session.add(row)
            session.flush()
            return _to_offer(row)

        return run_write_transaction(self._session_immediate, "create_skill_offer", write)

    def decide_offer(
        self, actor: NovaActor, offer_id: str, *, status: OfferStatus
    ) -> SkillOffer | None:
        """Move an open offer to ``SAVED`` or ``DISMISSED``, re-checking it is
        still open inside the write transaction (mirrors
        ``omnigent.nova.goals.sqlalchemy_store``'s proposal accept/dismiss)."""

        def write(session: Session) -> SkillOffer | None:
            row = session.get(SqlSkillOffer, (actor.workspace_id, offer_id))
            if row is None or row.user_id != actor.user_id:
                return None
            if row.status != OFFER_STATUS_CODE[OfferStatus.OPEN.value]:
                return None
            row.status = OFFER_STATUS_CODE[status.value]
            row.decided_at = now_epoch()
            session.flush()
            return _to_offer(row)

        return run_write_transaction(self._session_immediate, "decide_skill_offer", write)
