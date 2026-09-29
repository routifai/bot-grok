"""Domain types for a Goal: its plan of Tasks and its Proposals.

A Goal is an outcome the person wants over time. It has at most one open
Proposal at a time — a plan the person must accept before it takes effect.
The very first plan is a Proposal too, so a brand-new Goal has no live Tasks
until the person accepts it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class GoalStatus(StrEnum):
    """Lifecycle of a Goal."""

    ACTIVE = "active"
    PAUSED = "paused"
    CANCELLED = "cancelled"
    DONE = "done"


class TaskStatus(StrEnum):
    """Progress of one Task in a Goal's plan."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"
    SKIPPED = "skipped"


class ProposalStatus(StrEnum):
    """Lifecycle of a Proposal.

    ``OPEN`` is the only state a Goal may have more than zero of at once —
    a Goal has at most one. ``WITHDRAWN`` marks a Proposal superseded by a
    later one before the person answered it, distinct from ``DISMISSED``
    (the person said no).
    """

    OPEN = "open"
    ACCEPTED = "accepted"
    DISMISSED = "dismissed"
    WITHDRAWN = "withdrawn"


@dataclass(frozen=True)
class GoalTask:
    """One step in a Goal's plan.

    :param id: Stable id, unchanged across Proposals that keep this Task
        (see ``ProposedTask.keep_task_id``).
    :param idx: Position in the plan, 0-based.
    :param title: Short description of the step.
    :param status: Current progress.
    :param note: Free-text detail — why it's blocked, what was done. Empty
        when unset.
    :param created_at: Unix epoch seconds this Task was first created (when
        a Proposal naming it was accepted).
    :param updated_at: Unix epoch seconds of the last change — a status/note
        edit, or a reorder when a later Proposal is accepted — or ``None``.
    """

    id: str
    idx: int
    title: str
    status: TaskStatus
    note: str = ""
    created_at: int = 0
    updated_at: int | None = None


@dataclass(frozen=True)
class ProposedTask:
    """One line of a Proposal's plan, before it is accepted into real Tasks.

    :param title: Short description of the step.
    :param keep_task_id: When set, accepting this Proposal keeps the
        existing Task's id, status and note (only its position may change)
        instead of creating a fresh pending Task. ``None`` for a new step.
    """

    title: str
    keep_task_id: str | None = None


@dataclass(frozen=True)
class GoalProposal:
    """A proposed plan for a Goal, awaiting the person's decision.

    :param id: Stable id.
    :param goal_id: The Goal this Proposal belongs to.
    :param reason: Why this plan — "First plan" for a new Goal, or the
        model's stated reason for a revision.
    :param tasks: The proposed plan, in order.
    :param status: Current lifecycle state.
    :param created_at: Unix epoch seconds.
    :param decided_at: Unix epoch seconds the person accepted, dismissed, or
        it was withdrawn; ``None`` while still open.
    """

    id: str
    goal_id: str
    reason: str
    tasks: tuple[ProposedTask, ...]
    status: ProposalStatus
    created_at: int
    decided_at: int | None = None


@dataclass(frozen=True)
class Goal:
    """An outcome the person wants over time.

    :param id: Stable id.
    :param user_id: The person this Goal belongs to (the :class:`NovaActor`
        key). Goals are never shared.
    :param title: Short name for the outcome.
    :param description: Longer free-text detail. Empty when unset.
    :param due_date: A calendar date the person wants this done by,
        ``"YYYY-MM-DD"``, or ``None``.
    :param check_in_crons: Cron expressions (evaluated in ``timezone``) on
        which Nova should check in with the person about this Goal. Empty
        means no scheduled check-ins.
    :param timezone: IANA timezone check-ins and quiet hours are evaluated
        in, captured from the person at creation, e.g. ``"America/Toronto"``.
    :param status: Lifecycle state.
    :param tasks: The current plan, in order. Empty until a Proposal is
        accepted (every Goal, including a brand-new one, starts with no
        live Tasks — its first plan is a Proposal).
    :param open_proposal: The one Proposal awaiting the person's decision,
        or ``None`` if there isn't one.
    :param session_id: The Goal's own Omnigent session for background work
        on this Goal, or ``None`` if it has none yet. When created, that
        session is labelled ``nova.goal=<goal_id>`` and
        ``nova.scope=private`` (see ``omnigent/nova/goals/README.md``);
        creating it is not this primitive's job.
    :param created_at: Unix epoch seconds.
    :param updated_at: Unix epoch seconds of the last change, or ``None``.
    """

    id: str
    user_id: str
    title: str
    description: str
    due_date: str | None
    check_in_crons: tuple[str, ...]
    timezone: str
    status: GoalStatus
    tasks: tuple[GoalTask, ...] = field(default_factory=tuple)
    open_proposal: GoalProposal | None = None
    session_id: str | None = None
    created_at: int = 0
    updated_at: int | None = None
