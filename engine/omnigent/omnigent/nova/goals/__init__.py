"""Goals — what the person is working toward.

Public surface for other Nova primitives (import only from here, never from
``omnigent.nova.goals.<submodule>`` directly — see ``omnigent/nova/README.md``
rule 1). ``routes.create_router``, ``tools.TOOLS`` and ``context.context_section``
are discovered by ``omnigent/nova/_registry.py`` via their own modules and are
not re-exported here.
"""

from omnigent.nova.goals.entities import (
    Goal,
    GoalProposal,
    GoalStatus,
    GoalTask,
    ProposalStatus,
    ProposedTask,
    TaskStatus,
)
from omnigent.nova.goals.service import (
    GOAL_SESSION_LABEL_KEY,
    accept_proposal,
    create_goal,
    dismiss_proposal,
    goal_to_dict,
    in_quiet_hours,
    next_work_at,
    propose_plan,
    quiet_hours_end,
    render_goals,
    set_status,
    update_task,
)
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore
from omnigent.nova.goals.store import GoalStore

__all__ = [
    "GOAL_SESSION_LABEL_KEY",
    "Goal",
    "GoalProposal",
    "GoalStatus",
    "GoalStore",
    "GoalTask",
    "ProposalStatus",
    "ProposedTask",
    "TaskStatus",
    "accept_proposal",
    "create_goal",
    "create_store",
    "dismiss_proposal",
    "goal_to_dict",
    "in_quiet_hours",
    "next_work_at",
    "propose_plan",
    "quiet_hours_end",
    "render_goals",
    "set_status",
    "update_task",
]

# Lazily built, process-wide store used by tools.py and context.py — the
# places with no NovaDeps to thread a storage_location through. routes.py has
# deps and calls create_store directly instead. Mirrors
# ``omnigent.nova.memory``'s ``_runtime_store`` pattern.
_store: GoalStore | None = None


def create_store(storage_location: str) -> GoalStore:
    """Build the Goal store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`GoalStore`.
    """
    return SqlAlchemyGoalStore(storage_location)


def _runtime_store() -> GoalStore:
    """The store used where no :class:`NovaDeps` is available.

    ``tools.py`` (``nova_goals``) and ``context.py`` (``goals_active``) run
    deep inside the runtime, not from a route handler, so neither has a
    ``NovaDeps`` to read ``storage_location`` from. Both go through
    Omnigent's already-initialized conversation store instead, which lives
    in the same operational database (see ``NovaDeps(storage_location=...)``
    in ``server/app.py``) — one configuration path, not two. Cached for the
    process; :func:`omnigent.db.utils.get_or_create_engine` already caches
    the underlying engine by URI, so this is a small convenience on top, not
    the only thing keeping repeated calls cheap.

    Tests that need an isolated store patch this function directly (e.g.
    ``monkeypatch.setattr(goals, "_runtime_store", lambda: store)``).
    """
    global _store
    if _store is None:
        from omnigent.runtime import get_conversation_store

        _store = create_store(get_conversation_store().storage_location)
    return _store
