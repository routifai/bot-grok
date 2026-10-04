"""Suggestion store: persists Ideas an agent proposes under a parent session."""

from __future__ import annotations

import uuid

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlSuggestion, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.entities.suggestion import SUGGESTION_STATUSES, Suggestion

_MAX_TITLE = 256


def _to_entity(row: SqlSuggestion) -> Suggestion:
    return Suggestion(
        id=row.id,
        user_id=row.user_id,
        parent_session_id=row.parent_session_id,
        title=row.title,
        why=row.why,
        message=row.message,
        status=row.status,
        source_session_id=row.source_session_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class SqlAlchemySuggestionStore:
    """SQLAlchemy-backed store for the ``suggestions`` table (owner-scoped)."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        """
        self.storage_location = storage_location
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.suggestion_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.suggestion_store", immediate=True
        )

    def create(
        self,
        *,
        user_id: str | None,
        parent_session_id: str,
        title: str,
        why: str,
        message: str,
        source_session_id: str | None = None,
    ) -> Suggestion:
        """Insert an open suggestion."""
        now = now_epoch()

        def write(session: Session) -> Suggestion:
            row = SqlSuggestion(
                id=uuid.uuid4().hex,
                user_id=user_id,
                parent_session_id=parent_session_id,
                title=title.strip()[:_MAX_TITLE],
                why=why.strip(),
                message=message.strip(),
                status="open",
                source_session_id=source_session_id,
                created_at=now,
                updated_at=None,
            )
            session.add(row)
            session.flush()
            return _to_entity(row)

        return run_write_transaction(self._session_immediate, "insert_suggestion", write)

    def get(self, suggestion_id: str, *, user_id: str | None) -> Suggestion | None:
        """Return the owner's suggestion, or ``None`` (also for another owner's)."""
        with self._session("select_suggestion") as session:
            row = session.get(SqlSuggestion, (current_workspace_id(), suggestion_id))
            if row is None or row.user_id != user_id:
                return None
            return _to_entity(row)

    def list(
        self,
        *,
        user_id: str | None,
        parent_session_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[Suggestion]:
        """List the owner's suggestions, newest first."""
        with self._session("list_suggestions") as session:
            stmt = select(SqlSuggestion).where(
                SqlSuggestion.workspace_id == current_workspace_id()
            )
            if user_id is None:
                stmt = stmt.where(SqlSuggestion.user_id.is_(None))
            else:
                stmt = stmt.where(SqlSuggestion.user_id == user_id)
            if parent_session_id is not None:
                stmt = stmt.where(SqlSuggestion.parent_session_id == parent_session_id)
            if status is not None:
                stmt = stmt.where(SqlSuggestion.status == status)
            stmt = stmt.order_by(desc(SqlSuggestion.created_at), desc(SqlSuggestion.id)).limit(
                limit
            )
            return [_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def set_status(
        self, suggestion_id: str, *, user_id: str | None, status: str
    ) -> Suggestion | None:
        """Set the status of the owner's suggestion; ``None`` when not found."""
        if status not in SUGGESTION_STATUSES:
            raise ValueError(f"invalid suggestion status {status!r}")
        now = now_epoch()

        def write(session: Session) -> Suggestion | None:
            row = session.get(SqlSuggestion, (current_workspace_id(), suggestion_id))
            if row is None or row.user_id != user_id:
                return None
            row.status = status
            row.updated_at = now
            session.flush()
            return _to_entity(row)

        return run_write_transaction(self._session_immediate, "update_suggestion", write)
