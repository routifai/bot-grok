"""Goals — what the person is working toward.

Public surface for other Nova primitives (import only from here, never from
``omnigent.nova.goals.<submodule>`` directly — see ``omnigent/nova/README.md``
rule 1). ``routes.create_router``, ``tools.TOOLS`` and ``context.context_section``
are discovered by ``omnigent/nova/_registry.py`` via their own modules and are
not re-exported here.
"""

from omnigent.nova._shared import lazy_store
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

def create_store(storage_location: str) -> GoalStore:
    """Build the Goal store for *storage_location*.

    :param storage_location: The Omnigent operational database's URI.
    :returns: A ready-to-use :class:`GoalStore`.
    """
    return SqlAlchemyGoalStore(storage_location)


# The store used where no NovaDeps is available: tools.py (nova_goals) and
# context.py (goals_active). See omnigent.nova._shared.storage.lazy_store.
# Tests that need an isolated store patch this directly, e.g.
# ``monkeypatch.setattr(goals, "_runtime_store", lambda: store)``.
_runtime_store = lazy_store(create_store)
