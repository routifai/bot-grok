"""Tests for :class:`SqlAlchemyGoalStore` — persistence and owner scoping.

Business-rule tests (first plan vs. revision, blocked detection, ...) live in
``test_service.py``; this file exercises the store's own contract: CRUD
round-trips and that a Goal/Proposal/Task owned by someone else reads back as
not found, never revealing it exists.
"""

from __future__ import annotations

from omnigent.nova._shared import new_id
from omnigent.nova.goals.entities import GoalStatus, ProposedTask, TaskStatus
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _create(store: SqlAlchemyGoalStore, *, user_id: str = ALICE, tasks: list[str] | None = None):
    return store.create(
        new_id(),
        new_id(),
        user_id=user_id,
        title="Learn guitar",
        description="",
        due_date=None,
        check_in_crons=(),
        timezone="UTC",
        tasks=tasks or ["a"],
    )


def test_create_returns_goal_with_open_proposal(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert goal.user_id == ALICE
    assert goal.status == GoalStatus.ACTIVE
    assert goal.tasks == ()
    assert goal.open_proposal is not None
    assert goal.open_proposal.status.value == "open"
    assert goal.created_at > 0


def test_get_scoped_to_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert store.get(goal.id, user_id=ALICE) is not None
    assert store.get(goal.id, user_id=BOB) is None


def test_get_missing_returns_none(store: SqlAlchemyGoalStore) -> None:
    assert store.get(new_id(), user_id=ALICE) is None


def test_list_scoped_to_owner(store: SqlAlchemyGoalStore) -> None:
    _create(store, user_id=ALICE)
    _create(store, user_id=BOB)
    assert [g.user_id for g in store.list(user_id=ALICE)] == [ALICE]
    assert [g.user_id for g in store.list(user_id=BOB)] == [BOB]


def test_propose_returns_none_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    result = store.propose(
        new_id(), goal.id, user_id=BOB, reason="steal it", tasks=[ProposedTask(title="x")]
    )
    assert result is None


def test_accept_proposal_returns_none_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert store.accept_proposal(goal.open_proposal.id, user_id=BOB) is None  # type: ignore[union-attr]


def test_accept_proposal_returns_none_when_missing(store: SqlAlchemyGoalStore) -> None:
    assert store.accept_proposal(new_id(), user_id=ALICE) is None


def test_dismiss_proposal_returns_none_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert store.dismiss_proposal(goal.open_proposal.id, user_id=BOB) is None  # type: ignore[union-attr]


def test_update_task_returns_none_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert goal.open_proposal is not None
    accepted = store.accept_proposal(goal.open_proposal.id, user_id=ALICE)
    assert accepted is not None
    task = accepted.tasks[0]
    assert (
        store.update_task(accepted.id, task.id, user_id=BOB, status=TaskStatus.DONE, note=None)
        is None
    )


def test_update_task_returns_none_for_task_in_a_different_goal(store: SqlAlchemyGoalStore) -> None:
    goal_a = _create(store, user_id=ALICE, tasks=["a"])
    assert goal_a.open_proposal is not None
    accepted_a = store.accept_proposal(goal_a.open_proposal.id, user_id=ALICE)
    assert accepted_a is not None
    other_goal = store.create(
        new_id(),
        new_id(),
        user_id=ALICE,
        title="Other",
        description="",
        due_date=None,
        check_in_crons=(),
        timezone="UTC",
        tasks=["x"],
    )
    task_from_goal_a = accepted_a.tasks[0]
    # task_from_goal_a does not belong to other_goal.
    result = store.update_task(
        other_goal.id, task_from_goal_a.id, user_id=ALICE, status=TaskStatus.DONE, note=None
    )
    assert result is None


def test_set_status_returns_none_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    assert store.set_status(goal.id, user_id=BOB, status=GoalStatus.PAUSED) is None


def test_set_status_leaves_unspecified_fields_unchanged(store: SqlAlchemyGoalStore) -> None:
    goal = _create(store)
    updated = store.set_status(goal.id, user_id=ALICE, status=GoalStatus.PAUSED)
    assert updated is not None
    assert updated.status == GoalStatus.PAUSED
    assert updated.timezone == "UTC"


def test_check_in_crons_round_trip(store: SqlAlchemyGoalStore) -> None:
    goal = store.create(
        new_id(),
        new_id(),
        user_id=ALICE,
        title="Goal",
        description="",
        due_date="2026-12-31",
        check_in_crons=["0 9 * * MON", "0 9 * * FRI"],
        timezone="America/Toronto",
        tasks=["a"],
    )
    assert goal.due_date == "2026-12-31"
    assert goal.timezone == "America/Toronto"
    assert goal.check_in_crons == ("0 9 * * MON", "0 9 * * FRI")

    fetched = store.get(goal.id, user_id=ALICE)
    assert fetched is not None
    assert fetched.check_in_crons == ("0 9 * * MON", "0 9 * * FRI")
