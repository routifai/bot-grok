"""Store interface for Goals, their Tasks, and their Proposals.

Every method is scoped by ``user_id`` — Goals are never shared, so a Goal (or
Proposal, or Task) owned by someone else reads back as not found, the same
convention ``ProjectStore`` uses. ``workspace_id`` scoping is ambient (see
``omnigent.db.db_models.current_workspace_id``), not a parameter, matching
every other Omnigent store.

Methods that act on an existing Goal/Proposal return ``None`` when it does
not exist or is not owned by ``user_id``; callers (``service.py``) turn that
into a ``NOT_FOUND`` or ``CONFLICT`` :class:`~omnigent.errors.OmnigentError`
as appropriate for the operation.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

from omnigent.nova.goals.entities import Goal, GoalStatus, ProposedTask, TaskStatus


class GoalStore(ABC):
    """Abstract base for Goal persistence."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI,
            e.g. ``"sqlite:///chat.db"`` for SQLAlchemy.
        """
        self.storage_location = storage_location

    @abstractmethod
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
        """
        Create a new, active Goal together with its first-plan Proposal.

        The Goal starts with no live Tasks — ``tasks`` becomes the open
        Proposal's plan, not live rows, so the person accepts it before any
        Task exists (mirrors a later revision's ``propose`` /
        ``accept_proposal`` shape instead of being a special case).

        :param goal_id: Pre-generated id for the new Goal.
        :param proposal_id: Pre-generated id for its first-plan Proposal.
        :param user_id: Owning person.
        :param title: Already validated/trimmed title.
        :param description: Already validated/trimmed description.
        :param due_date: Already validated ``"YYYY-MM-DD"``, or ``None``.
        :param check_in_crons: Already validated/capped cron expressions.
        :param timezone: IANA timezone.
        :param tasks: Already validated/trimmed task titles for the first
            plan (non-empty).
        :returns: The new :class:`Goal`, with its first Proposal open.
        """

    @abstractmethod
    def get(self, goal_id: str, *, user_id: str) -> Goal | None:
        """Return an owned Goal by id, or ``None`` if not found/owned."""

    @abstractmethod
    def list(self, *, user_id: str) -> list[Goal]:
        """List the person's Goals, ordered by ``created_at ASC, id ASC``."""

    @abstractmethod
    def propose(
        self,
        proposal_id: str,
        goal_id: str,
        *,
        user_id: str,
        reason: str,
        tasks: Sequence[ProposedTask],
    ) -> Goal | None:
        """
        Open a new Proposal for a Goal, withdrawing any Proposal already open.

        A Goal has at most one open Proposal, so this is the single place
        that invariant is enforced: an existing open Proposal (if any) is
        marked ``withdrawn`` in the same transaction that opens the new one.
        Does not touch the Goal's live Tasks — only ``accept_proposal`` does.

        :param proposal_id: Pre-generated id for the new Proposal.
        :param goal_id: The Goal to propose a plan for.
        :param user_id: The requesting owner.
        :param reason: Already validated/trimmed reason for this plan.
        :param tasks: Already validated/capped proposed plan (non-empty).
        :returns: The updated :class:`Goal`, or ``None`` if not found/owned.
        """

    @abstractmethod
    def accept_proposal(self, proposal_id: str, *, user_id: str) -> Goal | None:
        """
        Accept an open Proposal: replace the Goal's plan with its Tasks.

        A proposed step with ``keep_task_id`` set keeps that Task's id,
        status and note — only its position may change; every other
        proposed step becomes a fresh ``pending`` Task. Existing Tasks not
        named by any ``keep_task_id`` are dropped.

        :param proposal_id: The Proposal to accept.
        :param user_id: The requesting owner (checked via the Proposal's
            Goal).
        :returns: The updated :class:`Goal`, or ``None`` if the Proposal
            does not exist, is not open, or its Goal is not owned by
            ``user_id``.
        """

    @abstractmethod
    def dismiss_proposal(self, proposal_id: str, *, user_id: str) -> Goal | None:
        """
        Dismiss an open Proposal, leaving the Goal's current plan untouched.

        :param proposal_id: The Proposal to dismiss.
        :param user_id: The requesting owner (checked via the Proposal's
            Goal).
        :returns: The updated :class:`Goal`, or ``None`` if the Proposal
            does not exist, is not open, or its Goal is not owned by
            ``user_id``.
        """

    @abstractmethod
    def update_task(
        self,
        goal_id: str,
        task_id: str,
        *,
        user_id: str,
        status: TaskStatus,
        note: str | None,
    ) -> tuple[Goal, bool] | None:
        """
        Update a Task's progress (never the plan's shape).

        :param goal_id: The Task's Goal.
        :param task_id: The Task to update.
        :param user_id: The requesting owner.
        :param status: The new status.
        :param note: Already validated/trimmed note to set, or ``None`` to
            leave the Task's current note unchanged.
        :returns: ``(goal, became_blocked)`` where ``became_blocked`` is
            ``True`` iff this update is the transition into ``blocked``
            (it was not already blocked) with a non-empty resulting note —
            the signal a caller uses to ask the person what's needed.
            ``None`` if the Goal/Task does not exist or is not owned.
        """

    @abstractmethod
    def set_status(
        self,
        goal_id: str,
        *,
        user_id: str,
        status: GoalStatus | None = None,
        check_in_crons: Sequence[str] | None = None,
        timezone: str | None = None,
    ) -> Goal | None:
        """
        Update a Goal's status and/or check-in schedule. ``None`` leaves a
        field unchanged.

        :param goal_id: The Goal to update.
        :param user_id: The requesting owner.
        :param status: New lifecycle status, or ``None`` to leave unchanged.
        :param check_in_crons: New cron list (already validated/capped), or
            ``None`` to leave unchanged.
        :param timezone: New IANA timezone, or ``None`` to leave unchanged.
        :returns: The updated :class:`Goal`, or ``None`` if not found/owned.
        """
