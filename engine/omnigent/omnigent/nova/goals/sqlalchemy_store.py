"""SQLAlchemy-backed implementation of :class:`GoalStore`."""

from __future__ import annotations

import json
from collections.abc import Sequence

from sqlalchemy import asc, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import new_id, now_s
from omnigent.nova.goals.entities import (
    Goal,
    GoalProposal,
    GoalStatus,
    GoalTask,
    ProposalStatus,
    ProposedTask,
    TaskStatus,
)
from omnigent.nova.goals.store import GoalStore
from omnigent.nova.goals.tables import (
    GOAL_STATUS_CODE,
    PROPOSAL_STATUS_CODE,
    TASK_STATUS_CODE,
    SqlGoal,
    SqlGoalProposal,
    SqlGoalTask,
)

# A JSON blob (cron list, proposed-task list) written verbatim into a
# compressed column. service.py already bounds item counts and lengths
# before a write reaches here; this is a defensive backstop, not the
# primary limit — see docs/DATABASE_BEST_PRACTICES.md's 16 KiB column rule.
_SERIALIZED_MAX_BYTES = 16_000

_TASK_STATUS_NAME = {code: name for name, code in TASK_STATUS_CODE.items()}
_GOAL_STATUS_NAME = {code: name for name, code in GOAL_STATUS_CODE.items()}
_PROPOSAL_STATUS_NAME = {code: name for name, code in PROPOSAL_STATUS_CODE.items()}


def _encode_json(value: object) -> str:
    """Serialize *value* to compact JSON, rejecting an oversized result."""
    blob = json.dumps(value, separators=(",", ":"))
    if len(blob.encode("utf-8")) > _SERIALIZED_MAX_BYTES:
        raise OmnigentError("Too much data for one Goal", code=ErrorCode.INVALID_INPUT)
    return blob


def _decode_cron_list(raw: str) -> list[str]:
    if not raw:
        return []
    decoded = json.loads(raw)
    return [c for c in decoded if isinstance(c, str)] if isinstance(decoded, list) else []


def _encode_proposed_tasks(tasks: Sequence[ProposedTask]) -> str:
    return _encode_json([{"title": t.title, "keep_task_id": t.keep_task_id} for t in tasks])


def _decode_proposed_tasks(raw: str) -> list[ProposedTask]:
    if not raw:
        return []
    decoded = json.loads(raw)
    if not isinstance(decoded, list):
        return []
    return [
        ProposedTask(title=item.get("title", ""), keep_task_id=item.get("keep_task_id"))
        for item in decoded
        if isinstance(item, dict)
    ]


def _to_task(row: SqlGoalTask) -> GoalTask:
    return GoalTask(
        id=row.id,
        idx=row.idx,
        title=row.title,
        status=TaskStatus(_TASK_STATUS_NAME[row.status]),
        note=row.note,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_proposal(row: SqlGoalProposal) -> GoalProposal:
    return GoalProposal(
        id=row.id,
        goal_id=row.goal_id,
        reason=row.reason,
        tasks=tuple(_decode_proposed_tasks(row.tasks)),
        status=ProposalStatus(_PROPOSAL_STATUS_NAME[row.status]),
        created_at=row.created_at,
        decided_at=row.decided_at,
    )


def _to_goal(row: SqlGoal, tasks: list[GoalTask], open_proposal: GoalProposal | None) -> Goal:
    return Goal(
        id=row.id,
        user_id=row.user_id,
        title=row.title,
        description=row.description,
        due_date=row.due_date,
        check_in_crons=tuple(_decode_cron_list(row.check_in_crons)),
        timezone=row.timezone,
        status=GoalStatus(_GOAL_STATUS_NAME[row.status]),
        tasks=tuple(tasks),
        open_proposal=open_proposal,
        session_id=row.session_id,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class SqlAlchemyGoalStore(GoalStore):
    """SQLAlchemy-backed :class:`GoalStore`."""

    def __init__(self, storage_location: str) -> None:
        """:param storage_location: SQLAlchemy database URI."""
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova.goal_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.nova.goal_store", immediate=True
        )

    # ── assembly ──────────────────────────────────────────────

    def _tasks_for(self, session: Session, goal_id: str) -> list[GoalTask]:
        stmt = (
            select(SqlGoalTask)
            .where(
                SqlGoalTask.workspace_id == current_workspace_id(),
                SqlGoalTask.goal_id == goal_id,
            )
            .order_by(asc(SqlGoalTask.idx), asc(SqlGoalTask.id))
        )
        return [_to_task(row) for row in session.execute(stmt).scalars().all()]

    def _open_proposal_for(self, session: Session, goal_id: str) -> GoalProposal | None:
        # At most one row can match (the invariant this store enforces), but
        # ordering + limit keeps the query correct even if that were ever
        # violated by a bug.
        stmt = (
            select(SqlGoalProposal)
            .where(
                SqlGoalProposal.workspace_id == current_workspace_id(),
                SqlGoalProposal.goal_id == goal_id,
                SqlGoalProposal.status == PROPOSAL_STATUS_CODE["open"],
            )
            .order_by(asc(SqlGoalProposal.created_at), asc(SqlGoalProposal.id))
            .limit(1)
        )
        row = session.execute(stmt).scalars().first()
        return _to_proposal(row) if row is not None else None

    def _load(self, session: Session, goal_id: str) -> Goal | None:
        row = session.get(SqlGoal, (current_workspace_id(), goal_id))
        if row is None:
            return None
        tasks = self._tasks_for(session, goal_id)
        proposal = self._open_proposal_for(session, goal_id)
        return _to_goal(row, tasks, proposal)

    def _withdraw_open_proposals(self, session: Session, goal_id: str, at: int) -> None:
        stmt = select(SqlGoalProposal).where(
            SqlGoalProposal.workspace_id == current_workspace_id(),
            SqlGoalProposal.goal_id == goal_id,
            SqlGoalProposal.status == PROPOSAL_STATUS_CODE["open"],
        )
        for row in session.execute(stmt).scalars().all():
            row.status = PROPOSAL_STATUS_CODE["withdrawn"]
            row.decided_at = at

    # ── GoalStore ─────────────────────────────────────────────

    def create(
        self,
        goal_id: str,
        proposal_id: str,
        *,
        user_id: str,
        title: str,
        description: str,
        due_date: str | None,
        check_in_crons: Sequence[str],
        timezone: str,
        tasks: Sequence[str],
    ) -> Goal:
        created_at = now_s()

        def write(session: Session) -> Goal:
            session.add(
                SqlGoal(
                    workspace_id=current_workspace_id(),
                    id=goal_id,
                    user_id=user_id,
                    title=title,
                    description=description,
                    due_date=due_date,
                    check_in_crons=_encode_json(list(check_in_crons)),
                    timezone=timezone,
                    status=GOAL_STATUS_CODE[GoalStatus.ACTIVE],
                    session_id=None,
                    created_at=created_at,
                    updated_at=None,
                )
            )
            session.add(
                SqlGoalProposal(
                    workspace_id=current_workspace_id(),
                    id=proposal_id,
                    goal_id=goal_id,
                    reason="First plan",
                    tasks=_encode_proposed_tasks([ProposedTask(title=t) for t in tasks]),
                    status=PROPOSAL_STATUS_CODE[ProposalStatus.OPEN],
                    created_at=created_at,
                    decided_at=None,
                )
            )
            session.flush()
            goal = self._load(session, goal_id)
            assert goal is not None  # just inserted, in the same transaction
            return goal

        return run_write_transaction(self._session_immediate, "create_goal", write)

    def get(self, goal_id: str, *, user_id: str) -> Goal | None:
        with self._session("select_goal") as session:
            goal = self._load(session, goal_id)
            return goal if goal is not None and goal.user_id == user_id else None

    def list(self, *, user_id: str) -> list[Goal]:
        with self._session("list_goals") as session:
            stmt = (
                select(SqlGoal)
                .where(SqlGoal.workspace_id == current_workspace_id(), SqlGoal.user_id == user_id)
                .order_by(asc(SqlGoal.created_at), asc(SqlGoal.id))
            )
            rows = session.execute(stmt).scalars().all()
            return [
                _to_goal(
                    row, self._tasks_for(session, row.id), self._open_proposal_for(session, row.id)
                )
                for row in rows
            ]

    def propose(
        self,
        proposal_id: str,
        goal_id: str,
        *,
        user_id: str,
        reason: str,
        tasks: Sequence[ProposedTask],
    ) -> Goal | None:
        created_at = now_s()

        def write(session: Session) -> Goal | None:
            goal_row = session.get(SqlGoal, (current_workspace_id(), goal_id))
            if goal_row is None or goal_row.user_id != user_id:
                return None
            self._withdraw_open_proposals(session, goal_id, created_at)
            session.add(
                SqlGoalProposal(
                    workspace_id=current_workspace_id(),
                    id=proposal_id,
                    goal_id=goal_id,
                    reason=reason,
                    tasks=_encode_proposed_tasks(tasks),
                    status=PROPOSAL_STATUS_CODE[ProposalStatus.OPEN],
                    created_at=created_at,
                    decided_at=None,
                )
            )
            session.flush()
            return self._load(session, goal_id)

        return run_write_transaction(self._session_immediate, "propose_goal_plan", write)

    def accept_proposal(self, proposal_id: str, *, user_id: str) -> Goal | None:
        decided_at = now_s()

        def write(session: Session) -> Goal | None:
            proposal = session.get(SqlGoalProposal, (current_workspace_id(), proposal_id))
            if proposal is None or proposal.status != PROPOSAL_STATUS_CODE[ProposalStatus.OPEN]:
                return None
            goal_row = session.get(SqlGoal, (current_workspace_id(), proposal.goal_id))
            if goal_row is None or goal_row.user_id != user_id:
                return None

            proposed = _decode_proposed_tasks(proposal.tasks)
            existing = (
                session.execute(
                    select(SqlGoalTask).where(
                        SqlGoalTask.workspace_id == current_workspace_id(),
                        SqlGoalTask.goal_id == goal_row.id,
                    )
                )
                .scalars()
                .all()
            )
            existing_by_id = {row.id: row for row in existing}
            keep_ids = {t.keep_task_id for t in proposed if t.keep_task_id}
            for row in existing:
                if row.id not in keep_ids:
                    session.delete(row)
            for idx, proposed_task in enumerate(proposed):
                kept = (
                    existing_by_id.get(proposed_task.keep_task_id)
                    if proposed_task.keep_task_id
                    else None
                )
                if kept is not None:
                    # Carried over: title/status/note are untouched, only its
                    # position (and so its updated_at) moves.
                    if kept.idx != idx:
                        kept.idx = idx
                        kept.updated_at = decided_at
                else:
                    session.add(
                        SqlGoalTask(
                            workspace_id=current_workspace_id(),
                            id=new_id(),
                            goal_id=goal_row.id,
                            idx=idx,
                            title=proposed_task.title,
                            status=TASK_STATUS_CODE[TaskStatus.PENDING],
                            note="",
                            created_at=decided_at,
                            updated_at=None,
                        )
                    )
            proposal.status = PROPOSAL_STATUS_CODE[ProposalStatus.ACCEPTED]
            proposal.decided_at = decided_at
            session.flush()
            return self._load(session, goal_row.id)

        return run_write_transaction(self._session_immediate, "accept_goal_proposal", write)

    def dismiss_proposal(self, proposal_id: str, *, user_id: str) -> Goal | None:
        decided_at = now_s()

        def write(session: Session) -> Goal | None:
            proposal = session.get(SqlGoalProposal, (current_workspace_id(), proposal_id))
            if proposal is None or proposal.status != PROPOSAL_STATUS_CODE[ProposalStatus.OPEN]:
                return None
            goal_row = session.get(SqlGoal, (current_workspace_id(), proposal.goal_id))
            if goal_row is None or goal_row.user_id != user_id:
                return None
            proposal.status = PROPOSAL_STATUS_CODE[ProposalStatus.DISMISSED]
            proposal.decided_at = decided_at
            session.flush()
            return self._load(session, goal_row.id)

        return run_write_transaction(self._session_immediate, "dismiss_goal_proposal", write)

    def update_task(
        self,
        goal_id: str,
        task_id: str,
        *,
        user_id: str,
        status: TaskStatus,
        note: str | None,
    ) -> tuple[Goal, bool] | None:
        updated_at = now_s()

        def write(session: Session) -> tuple[Goal, bool] | None:
            goal_row = session.get(SqlGoal, (current_workspace_id(), goal_id))
            if goal_row is None or goal_row.user_id != user_id:
                return None
            task_row = session.get(SqlGoalTask, (current_workspace_id(), task_id))
            if task_row is None or task_row.goal_id != goal_id:
                return None

            was_blocked = task_row.status == TASK_STATUS_CODE[TaskStatus.BLOCKED]
            task_row.status = TASK_STATUS_CODE[status]
            final_note = note if note is not None else task_row.note
            task_row.note = final_note
            task_row.updated_at = updated_at
            session.flush()
            goal = self._load(session, goal_id)
            assert goal is not None
            became_blocked = status == TaskStatus.BLOCKED and not was_blocked and bool(final_note)
            return goal, became_blocked

        return run_write_transaction(self._session_immediate, "update_goal_task", write)

    def set_status(
        self,
        goal_id: str,
        *,
        user_id: str,
        status: GoalStatus | None = None,
        check_in_crons: Sequence[str] | None = None,
        timezone: str | None = None,
    ) -> Goal | None:
        updated_at = now_s()

        def write(session: Session) -> Goal | None:
            goal_row = session.get(SqlGoal, (current_workspace_id(), goal_id))
            if goal_row is None or goal_row.user_id != user_id:
                return None
            changed = False
            if status is not None and GOAL_STATUS_CODE[status] != goal_row.status:
                goal_row.status = GOAL_STATUS_CODE[status]
                changed = True
            if check_in_crons is not None:
                encoded = _encode_json(list(check_in_crons))
                if encoded != goal_row.check_in_crons:
                    goal_row.check_in_crons = encoded
                    changed = True
            if timezone is not None and timezone != goal_row.timezone:
                goal_row.timezone = timezone
                changed = True
            if changed:
                goal_row.updated_at = updated_at
            session.flush()
            return self._load(session, goal_id)

        return run_write_transaction(self._session_immediate, "set_goal_status", write)
