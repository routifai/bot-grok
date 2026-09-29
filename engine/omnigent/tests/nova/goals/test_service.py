"""Tests for ``omnigent.nova.goals.service``.

Plan rules (first plan vs. revision, one open Proposal, accept replaces
Tasks, blocked detection) are exercised against a real
:class:`SqlAlchemyGoalStore` (the ``store`` fixture, SQLite-backed) since
they are about the interaction between validation and persistence.
Rendering and quiet-hours are pure and tested standalone.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import new_id
from omnigent.nova.goals import service
from omnigent.nova.goals.entities import (
    Goal,
    GoalProposal,
    GoalStatus,
    GoalTask,
    ProposedTask,
    TaskStatus,
)
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore

ALICE = "alice@example.com"


# ── create_goal ───────────────────────────────────────────


def test_create_goal_opens_first_plan_as_proposal(store: SqlAlchemyGoalStore) -> None:
    """A new Goal has no live Tasks; its first plan is an open Proposal."""
    goal = service.create_goal(
        store, user_id=ALICE, title="Learn guitar", tasks=["Buy one", "Practice"]
    )
    assert goal.tasks == ()
    assert goal.status == GoalStatus.ACTIVE
    assert goal.open_proposal is not None
    assert goal.open_proposal.reason == "First plan"
    assert [t.title for t in goal.open_proposal.tasks] == ["Buy one", "Practice"]


def test_create_goal_requires_title(store: SqlAlchemyGoalStore) -> None:
    with pytest.raises(OmnigentError) as exc:
        service.create_goal(store, user_id=ALICE, title="   ", tasks=["a"])
    assert exc.value.code == ErrorCode.INVALID_INPUT


def test_create_goal_requires_at_least_one_task(store: SqlAlchemyGoalStore) -> None:
    with pytest.raises(OmnigentError) as exc:
        service.create_goal(store, user_id=ALICE, title="Goal", tasks=["  ", ""])
    assert exc.value.code == ErrorCode.INVALID_INPUT


def test_create_goal_rejects_bad_due_date(store: SqlAlchemyGoalStore) -> None:
    with pytest.raises(OmnigentError):
        service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"], due_date="not-a-date")


def test_create_goal_caps_check_in_crons(store: SqlAlchemyGoalStore) -> None:
    many = [f"{m} * * * *" for m in range(20)]
    goal = service.create_goal(
        store, user_id=ALICE, title="Goal", tasks=["a"], check_in_crons=many
    )
    assert len(goal.check_in_crons) == service.MAX_CHECK_IN_CRONS


# ── propose_plan: revision vs. first plan, one open Proposal ─


def test_propose_plan_opens_a_revision(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    revised = service.propose_plan(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        reason="Change tack",
        tasks=[ProposedTask(title="b")],
    )
    assert revised.open_proposal is not None
    assert revised.open_proposal.reason == "Change tack"
    assert revised.open_proposal.id != goal.open_proposal.id  # type: ignore[union-attr]


def test_propose_plan_withdraws_the_previously_open_proposal(store: SqlAlchemyGoalStore) -> None:
    """A Goal never has more than one open Proposal: proposing again withdraws the old one."""
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    first_proposal_id = goal.open_proposal.id  # type: ignore[union-attr]
    service.propose_plan(
        store, user_id=ALICE, goal_id=goal.id, reason="Revision", tasks=[ProposedTask(title="b")]
    )
    # The original proposal is no longer open — accepting it now is a conflict.
    with pytest.raises(OmnigentError) as exc:
        service.accept_proposal(store, user_id=ALICE, proposal_id=first_proposal_id)
    assert exc.value.code == ErrorCode.CONFLICT


def test_propose_plan_requires_a_reason_and_tasks(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    with pytest.raises(OmnigentError):
        service.propose_plan(
            store, user_id=ALICE, goal_id=goal.id, reason="", tasks=[ProposedTask(title="b")]
        )
    with pytest.raises(OmnigentError):
        service.propose_plan(store, user_id=ALICE, goal_id=goal.id, reason="ok", tasks=[])


def test_propose_plan_not_found_for_unknown_goal(store: SqlAlchemyGoalStore) -> None:
    with pytest.raises(OmnigentError) as exc:
        service.propose_plan(
            store, user_id=ALICE, goal_id=new_id(), reason="x", tasks=[ProposedTask(title="a")]
        )
    assert exc.value.code == ErrorCode.NOT_FOUND


# ── accept_proposal replaces the plan ─────────────────────


def test_accept_first_proposal_creates_pending_tasks(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a", "b"])
    accepted = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    assert accepted.open_proposal is None
    assert [t.status for t in accepted.tasks] == [TaskStatus.PENDING, TaskStatus.PENDING]
    assert [t.title for t in accepted.tasks] == ["a", "b"]


def test_accept_revision_keeps_named_tasks_and_drops_the_rest(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a", "b"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    task_a, task_b = goal.tasks
    # Move "a" into progress with a note before it's carried over.
    goal, _ = service.update_task(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        task_id=task_a.id,
        status=TaskStatus.IN_PROGRESS,
        note="halfway",
    )

    revised = service.propose_plan(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        reason="Drop b, add c",
        tasks=[ProposedTask(title="a", keep_task_id=task_a.id), ProposedTask(title="c")],
    )
    accepted = service.accept_proposal(store, user_id=ALICE, proposal_id=revised.open_proposal.id)  # type: ignore[union-attr]

    by_title = {t.title: t for t in accepted.tasks}
    assert set(by_title) == {"a", "c"}
    # "a" kept its id, status and note — only its position could move.
    assert by_title["a"].id == task_a.id
    assert by_title["a"].status == TaskStatus.IN_PROGRESS
    assert by_title["a"].note == "halfway"
    # "c" is a fresh pending task.
    assert by_title["c"].status == TaskStatus.PENDING
    # "b" was dropped.
    assert task_b.id not in {t.id for t in accepted.tasks}


def test_accept_proposal_conflict_when_not_open(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    proposal_id = goal.open_proposal.id  # type: ignore[union-attr]
    service.accept_proposal(store, user_id=ALICE, proposal_id=proposal_id)
    with pytest.raises(OmnigentError) as exc:
        service.accept_proposal(store, user_id=ALICE, proposal_id=proposal_id)
    assert exc.value.code == ErrorCode.CONFLICT


def test_dismiss_proposal_leaves_the_plan_untouched(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    revised = service.propose_plan(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        reason="Try dropping a",
        tasks=[ProposedTask(title="b")],
    )
    assert revised.open_proposal is not None
    dismissed = service.dismiss_proposal(
        store, user_id=ALICE, proposal_id=revised.open_proposal.id
    )
    assert dismissed.open_proposal is None
    assert [t.title for t in dismissed.tasks] == ["a"]


# ── update_task: blocked detection ────────────────────────


def test_update_task_becoming_blocked_with_a_note(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    task = goal.tasks[0]

    updated, became_blocked = service.update_task(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        task_id=task.id,
        status=TaskStatus.BLOCKED,
        note="need input",
    )
    assert became_blocked is True
    assert updated.tasks[0].status == TaskStatus.BLOCKED
    assert updated.tasks[0].note == "need input"


def test_update_task_blocked_without_a_note_does_not_ask(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    task = goal.tasks[0]

    _, became_blocked = service.update_task(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        task_id=task.id,
        status=TaskStatus.BLOCKED,
        note=None,
    )
    assert became_blocked is False


def test_update_task_already_blocked_does_not_ask_again(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    task = goal.tasks[0]

    goal, _ = service.update_task(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        task_id=task.id,
        status=TaskStatus.BLOCKED,
        note="first",
    )
    _, became_blocked_again = service.update_task(
        store,
        user_id=ALICE,
        goal_id=goal.id,
        task_id=task.id,
        status=TaskStatus.BLOCKED,
        note="still stuck",
    )
    assert became_blocked_again is False


def test_update_task_not_found(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    with pytest.raises(OmnigentError) as exc:
        service.update_task(
            store, user_id=ALICE, goal_id=goal.id, task_id=new_id(), status=TaskStatus.DONE
        )
    assert exc.value.code == ErrorCode.NOT_FOUND


# ── set_status ─────────────────────────────────────────────


def test_set_status_updates_lifecycle(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    paused = service.set_status(store, user_id=ALICE, goal_id=goal.id, status=GoalStatus.PAUSED)
    assert paused.status == GoalStatus.PAUSED


def test_set_status_not_found_for_other_owner(store: SqlAlchemyGoalStore) -> None:
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    with pytest.raises(OmnigentError) as exc:
        service.set_status(
            store, user_id="bob@example.com", goal_id=goal.id, status=GoalStatus.PAUSED
        )
    assert exc.value.code == ErrorCode.NOT_FOUND


# ── render_goals ───────────────────────────────────────────


def _goal(**overrides: object) -> Goal:
    defaults: dict[str, object] = {
        "id": "g1",
        "user_id": ALICE,
        "title": "Learn guitar",
        "description": "",
        "due_date": None,
        "check_in_crons": (),
        "timezone": "UTC",
        "status": GoalStatus.ACTIVE,
        "tasks": (),
        "open_proposal": None,
    }
    defaults.update(overrides)
    return Goal(**defaults)  # type: ignore[arg-type]


def test_render_goals_empty_list() -> None:
    assert service.render_goals([], 8192) == ""


def test_render_goals_focus_mode_selects_one_goal() -> None:
    goals = [_goal(id="g1", title="First"), _goal(id="g2", title="Second")]
    rendered = service.render_goals(goals, 8192, focus_goal_id="g2")
    assert "Second" in rendered
    assert "First" not in rendered


def test_render_goals_focus_mode_no_match_is_empty() -> None:
    goals = [_goal(id="g1")]
    assert service.render_goals(goals, 8192, focus_goal_id="nope") == ""


def test_render_goals_respects_byte_budget() -> None:
    goals = [_goal(id=f"g{i}", title="x" * 500) for i in range(50)]
    rendered = service.render_goals(goals, 1024)
    assert len(rendered.encode("utf-8")) <= 1024


def test_render_goals_tiny_budget_still_bounded() -> None:
    goals = [_goal()]
    rendered = service.render_goals(goals, 10)
    assert len(rendered.encode("utf-8")) <= 10


def test_render_goals_shows_task_icons_and_open_proposal() -> None:
    task = GoalTask(id="t1", idx=0, title="Buy strings", status=TaskStatus.BLOCKED, note="no cash")

    proposal = GoalProposal(
        id="p1",
        goal_id="g1",
        reason="Simplify",
        tasks=(ProposedTask(title="New step"),),
        status=service.ProposalStatus.OPEN if hasattr(service, "ProposalStatus") else None,  # type: ignore[attr-defined]
        created_at=0,
    )
    goal = _goal(tasks=(task,), open_proposal=proposal)
    rendered = service.render_goals([goal], 8192)
    assert "[!] 0. Buy strings" in rendered
    assert "no cash" in rendered
    assert "Simplify" in rendered
    assert "New step" in rendered


# ── quiet hours / next_work_at ─────────────────────────────


def test_in_quiet_hours_simple_window() -> None:
    tz = "America/Toronto"
    inside = datetime(2026, 1, 5, 23, 0, tzinfo=ZoneInfo(tz))
    outside = datetime(2026, 1, 5, 12, 0, tzinfo=ZoneInfo(tz))
    assert service.in_quiet_hours("22:00-07:00", inside, tz) is True
    assert service.in_quiet_hours("22:00-07:00", outside, tz) is False


def test_in_quiet_hours_none_when_unset() -> None:
    tz = "America/Toronto"
    now = datetime(2026, 1, 5, 23, 0, tzinfo=ZoneInfo(tz))
    assert service.in_quiet_hours(None, now, tz) is False
    assert service.in_quiet_hours("", now, tz) is False


def test_quiet_hours_across_spring_forward_dst_in_toronto() -> None:
    """America/Toronto springs forward at 02:00 -> 03:00 on 2026-03-08.

    A quiet-hours window straddling the gap must end at the right
    wall-clock time, and the *real* elapsed time to get there must reflect
    the skipped hour — not a naive fixed-offset addition.
    """
    tz = "America/Toronto"
    now = datetime(2026, 3, 8, 1, 30, tzinfo=ZoneInfo(tz))  # 01:30 EST, before the jump
    end = service.quiet_hours_end("01:00-04:00", now, tz)
    assert end is not None
    assert (end.hour, end.minute) == (4, 0)
    assert end.utcoffset() == timedelta(hours=-4)  # now in EDT
    assert now.utcoffset() == timedelta(hours=-5)  # was in EST

    # Wall-clock gap looks like 2h30m, but only 1h30m of real time passed.
    real_elapsed = end.astimezone(ZoneInfo("UTC")) - now.astimezone(ZoneInfo("UTC"))
    assert real_elapsed == timedelta(hours=1, minutes=30)


def test_next_work_at_none_when_not_active() -> None:
    tz = "America/Toronto"
    now = datetime(2026, 3, 8, 1, 30, tzinfo=ZoneInfo(tz))
    goal = _goal(status=GoalStatus.PAUSED)
    assert service.next_work_at(goal, now, "01:00-04:00", tz) is None


def test_next_work_at_returns_now_outside_quiet_hours() -> None:
    tz = "America/Toronto"
    now = datetime(2026, 6, 1, 12, 0, tzinfo=ZoneInfo(tz))
    goal = _goal(status=GoalStatus.ACTIVE)
    assert service.next_work_at(goal, now, "22:00-07:00", tz) == now


def test_next_work_at_pushed_past_dst_quiet_hours() -> None:
    tz = "America/Toronto"
    now = datetime(2026, 3, 8, 1, 30, tzinfo=ZoneInfo(tz))
    goal = _goal(status=GoalStatus.ACTIVE)
    result = service.next_work_at(goal, now, "01:00-04:00", tz)
    assert result is not None
    assert (result.hour, result.minute) == (4, 0)
    assert result > now
