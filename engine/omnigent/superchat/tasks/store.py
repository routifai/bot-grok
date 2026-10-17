"""The ``tasks`` and ``card_answers`` tables: a Conversation's deliverables in progress, and the
picks on the cards that asked about them (ADR 0025)."""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlCardAnswer, SqlTask, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.superchat.tasks.record import ACTIVE, DROPPED, CardAnswer, Task

#: The newest tasks of a Conversation that are read at once.
_LISTED = 20


def _loads(raw: str, empty: Any) -> Any:
    try:
        value = json.loads(raw)
    except ValueError:
        return empty
    return value if isinstance(value, type(empty)) else empty


def _to_entity(row: SqlTask) -> Task:
    return Task(
        id=row.id,
        owner=row.owner,
        conversation_id=row.conversation_id,
        kind=row.kind,
        title=row.title,
        fields=_loads(row.fields, {}),
        status=row.status,
        artifact_group_ids=[str(g) for g in _loads(row.artifact_group_ids, [])],
        helper_ids=[str(h) for h in _loads(row.helper_ids, [])],
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class SqlAlchemyTaskStore:
    """SQLAlchemy-backed store for the ``tasks`` and ``card_answers`` tables."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        """
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.task_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.task_store", immediate=True
        )

    def create(self, owner: str, conversation_id: str, kind: str, title: str) -> Task:
        """A new open task, not yet stored (:meth:`save` stores it)."""
        now = now_epoch()
        return Task(
            id=uuid.uuid4().hex,
            owner=owner,
            conversation_id=conversation_id,
            kind=kind,
            title=title[:256],
            created_at=now,
            updated_at=now,
        )

    def save(self, task: Task) -> Task:
        """Insert or update *task*; its ``updated_at`` becomes now."""
        task.updated_at = now_epoch()

        def write(session: Session) -> None:
            row = session.get(SqlTask, (current_workspace_id(), task.id))
            if row is None:
                row = SqlTask(id=task.id, created_at=task.created_at or task.updated_at)
                session.add(row)
            row.owner = task.owner
            row.conversation_id = task.conversation_id
            row.kind = task.kind
            row.title = task.title[:256]
            row.fields = json.dumps(task.fields, ensure_ascii=False)
            row.status = task.status
            row.artifact_group_ids = json.dumps(task.artifact_group_ids)
            row.helper_ids = json.dumps(task.helper_ids)
            row.updated_at = task.updated_at

        run_write_transaction(self._session_immediate, "task_save", write)
        return task

    def list(self, conversation_id: str, *, active_only: bool = False) -> list[Task]:
        """The Conversation's tasks, most recently changed first."""
        with self._session("list_tasks") as session:
            stmt = select(SqlTask).where(
                SqlTask.workspace_id == current_workspace_id(),
                SqlTask.conversation_id == conversation_id,
            )
            if active_only:
                stmt = stmt.where(SqlTask.status.in_(ACTIVE))
            stmt = stmt.order_by(SqlTask.updated_at.desc(), SqlTask.created_at.desc())
            rows = session.execute(stmt.limit(_LISTED)).scalars().all()
            return [_to_entity(row) for row in rows]

    def drop_stale(self, conversation_id: str, before: int) -> None:
        """Drop the Conversation's active tasks nothing touched since *before* (epoch seconds)."""

        def write(session: Session) -> None:
            session.execute(
                update(SqlTask)
                .where(
                    SqlTask.workspace_id == current_workspace_id(),
                    SqlTask.conversation_id == conversation_id,
                    SqlTask.status.in_(ACTIVE),
                    SqlTask.updated_at < before,
                )
                .values(status=DROPPED, updated_at=now_epoch())
            )

        run_write_transaction(self._session_immediate, "task_drop_stale", write)

    def get(self, task_id: str) -> Task | None:
        """One task by id, or ``None``."""
        with self._session("get_task") as session:
            row = session.get(SqlTask, (current_workspace_id(), task_id))
            return _to_entity(row) if row is not None else None

    def save_answer(
        self, conversation_id: str, item_id: str, answer: CardAnswer, task_id: str | None
    ) -> None:
        """Keep *answer* on the person's message *item_id* (once; a repeat replaces it)."""

        def write(session: Session) -> None:
            row = session.get(SqlCardAnswer, (current_workspace_id(), conversation_id, item_id))
            if row is None:
                row = SqlCardAnswer(session_id=conversation_id, item_id=item_id)
                session.add(row)
            row.card_id = answer.card_id
            row.option_id = answer.option_id
            row.label = answer.label
            row.task_id = task_id
            row.created_at = now_epoch()

        run_write_transaction(self._session_immediate, "card_answer_save", write)

    def answer(self, conversation_id: str, item_id: str) -> CardAnswer | None:
        """The card answer the person's message *item_id* carried, or ``None``."""
        with self._session("card_answer_get") as session:
            row = session.get(SqlCardAnswer, (current_workspace_id(), conversation_id, item_id))
            return CardAnswer(row.card_id, row.option_id, row.label) if row is not None else None

    def delete_conversation(self, conversation_id: str) -> None:
        """Drop every task and card answer of a deleted Conversation."""

        def write(session: Session) -> None:
            session.execute(
                delete(SqlTask).where(
                    SqlTask.workspace_id == current_workspace_id(),
                    SqlTask.conversation_id == conversation_id,
                )
            )
            session.execute(
                delete(SqlCardAnswer).where(
                    SqlCardAnswer.workspace_id == current_workspace_id(),
                    SqlCardAnswer.session_id == conversation_id,
                )
            )

        run_write_transaction(self._session_immediate, "task_delete_conversation", write)
