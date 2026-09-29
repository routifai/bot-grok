"""SQLAlchemy-backed Ask store."""

from __future__ import annotations

import json
from dataclasses import replace

from sqlalchemy import desc, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from omnigent.db.db_models import current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova.asks.entities import Ask, AskAction, AskKind, AskStatus
from omnigent.nova.asks.store import MAX_OPEN_ASKS, AskStore
from omnigent.nova.asks.tables import SqlNovaAsk

# Serialized ``actions`` must stay well under the 16 KiB column-value limit
# (docs/DATABASE_BEST_PRACTICES.md); four 80-char options plus ids and JSON
# punctuation land nowhere near this, so it is a defensive cap, not a
# realistic one.
_ACTIONS_MAX_SERIALIZED_LEN = 2000


def _encode_actions(actions: tuple[AskAction, ...]) -> str | None:
    """Pack an Ask's actions into a compact JSON array, or ``None`` if empty.

    :param actions: The Ask's tappable options.
    :returns: Compact JSON array string, or ``None`` for a free-text Ask.
    :raises OmnigentError: ``INVALID_INPUT`` if the serialized form is
        implausibly large (see :data:`_ACTIONS_MAX_SERIALIZED_LEN`).
    """
    if not actions:
        return None
    blob = json.dumps([{"id": a.id, "label": a.label} for a in actions], separators=(",", ":"))
    if len(blob) > _ACTIONS_MAX_SERIALIZED_LEN:
        raise OmnigentError(
            f"Ask actions too large ({len(blob)} bytes)", code=ErrorCode.INVALID_INPUT
        )
    return blob


def _decode_actions(raw: str | None) -> tuple[AskAction, ...]:
    """Unpack the stored ``actions_json`` blob (``()`` when unset or malformed).

    :param raw: The stored JSON blob, or ``None``.
    :returns: The decoded actions, defensively empty on any shape mismatch.
    """
    if not raw:
        return ()
    decoded = json.loads(raw)
    if not isinstance(decoded, list):
        return ()
    return tuple(
        AskAction(id=item["id"], label=item["label"])
        for item in decoded
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and isinstance(item.get("label"), str)
    )


def _to_row(ask: Ask) -> SqlNovaAsk:
    """Build a new :class:`SqlNovaAsk` row from an :class:`Ask` entity."""
    return SqlNovaAsk(
        workspace_id=ask.workspace_id,
        id=ask.id,
        user_id=ask.user_id,
        session_id=ask.session_id,
        kind=ask.kind.value,
        text=ask.text,
        detail=ask.detail,
        actions_json=_encode_actions(ask.actions),
        status=ask.status.value,
        answer=ask.answer,
        elicitation_id=ask.elicitation_id,
        goal_id=ask.goal_id,
        task_id=ask.task_id,
        created_at=ask.created_at,
        answered_at=ask.answered_at,
    )


def _to_entity(row: SqlNovaAsk) -> Ask:
    """Convert a :class:`SqlNovaAsk` ORM row to an :class:`Ask` entity."""
    return Ask(
        id=row.id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        session_id=row.session_id,
        kind=AskKind(row.kind),
        text=row.text,
        detail=row.detail,
        actions=_decode_actions(row.actions_json),
        status=AskStatus(row.status),
        answer=row.answer,
        elicitation_id=row.elicitation_id,
        goal_id=row.goal_id,
        task_id=row.task_id,
        created_at=row.created_at,
        answered_at=row.answered_at,
    )


class SqlAlchemyAskStore(AskStore):
    """SQLAlchemy-backed implementation of :class:`AskStore`."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI,
            e.g. ``"sqlite:///chat.db"``.
        """
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova_asks"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova_asks", immediate=True
        )

    def create(self, ask: Ask) -> Ask:
        """Insert a new Ask.

        Relies on ``ix_nova_asks_elicitation`` to reject a duplicate mirror
        of the same elicitation; no separate check-then-write, since the
        unique index makes the race harmless rather than merely unlikely.
        """
        row = _to_row(ask)

        def write(session: Session) -> Ask:
            session.add(row)
            session.flush()
            return _to_entity(row)

        try:
            return run_write_transaction(self._session_immediate, "insert_ask", write)
        except IntegrityError as exc:
            raise OmnigentError(
                "An Ask for this elicitation already exists", code=ErrorCode.ALREADY_EXISTS
            ) from exc

    def get(self, ask_id: str, *, user_id: str) -> Ask | None:
        """Return one of the person's Asks by id, or ``None`` if not found."""
        with self._session("select_ask_by_id") as session:
            row = session.get(SqlNovaAsk, (current_workspace_id(), ask_id))
            if row is None or row.user_id != user_id:
                return None
            return _to_entity(row)

    def get_by_elicitation(self, elicitation_id: str) -> Ask | None:
        """Return the Ask mirroring a given Omnigent elicitation, if any."""
        with self._session("select_ask_by_elicitation") as session:
            stmt = select(SqlNovaAsk).where(
                SqlNovaAsk.workspace_id == current_workspace_id(),
                SqlNovaAsk.elicitation_id == elicitation_id,
            )
            row = session.execute(stmt).scalar_one_or_none()
            return _to_entity(row) if row is not None else None

    def list_open(self, *, user_id: str, limit: int = MAX_OPEN_ASKS) -> list[Ask]:
        """List the person's open Asks, newest first (bounded scan)."""
        bounded_limit = min(limit, MAX_OPEN_ASKS)
        with self._session("list_open_asks") as session:
            stmt = (
                select(SqlNovaAsk)
                .where(
                    SqlNovaAsk.workspace_id == current_workspace_id(),
                    SqlNovaAsk.user_id == user_id,
                    SqlNovaAsk.status == AskStatus.OPEN.value,
                )
                .order_by(desc(SqlNovaAsk.created_at), desc(SqlNovaAsk.id))
                .limit(bounded_limit)
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_entity(r) for r in rows]

    def set_status(
        self,
        ask_id: str,
        *,
        user_id: str,
        status: AskStatus,
        answer: str | None,
        answered_at: int | None,
    ) -> Ask | None:
        """Move an Ask out of ``open``; a no-op if it already left ``open``."""

        def write(session: Session) -> Ask | None:
            row = session.get(SqlNovaAsk, (current_workspace_id(), ask_id))
            if row is None or row.user_id != user_id:
                return None
            if row.status == AskStatus.OPEN.value:
                row.status = status.value
                row.answer = answer
                row.answered_at = answered_at
                session.flush()
            return _to_entity(row)

        return run_write_transaction(self._session_immediate, "set_ask_status", write)

    def expire_open_for_session(self, session_id: str, *, now: int) -> list[Ask]:
        """Expire every open Ask tied to a session."""

        def write(session: Session) -> list[Ask]:
            workspace_id = current_workspace_id()
            stmt = select(SqlNovaAsk).where(
                SqlNovaAsk.workspace_id == workspace_id,
                SqlNovaAsk.session_id == session_id,
                SqlNovaAsk.status == AskStatus.OPEN.value,
            )
            rows = session.execute(stmt).scalars().all()
            if not rows:
                return []
            ids = [row.id for row in rows]
            session.execute(
                update(SqlNovaAsk)
                .where(
                    SqlNovaAsk.workspace_id == workspace_id,
                    SqlNovaAsk.id.in_(ids),
                )
                .values(status=AskStatus.EXPIRED.value, answered_at=now)
            )
            session.flush()
            return [
                replace(_to_entity(row), status=AskStatus.EXPIRED, answered_at=now) for row in rows
            ]

        return run_write_transaction(self._session_immediate, "expire_asks_for_session", write)
