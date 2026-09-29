"""Tests for the ``goals_active`` context section.

Covers privacy (private-scope only), focus mode (a Goal's own session shows
only that Goal, in full, regardless of status), and the general list mode
(active/paused Goals only).
"""

from __future__ import annotations

from omnigent.nova._shared import ContextRequest, NovaActor, Scope
from omnigent.nova.goals import service
from omnigent.nova.goals.context import context_section
from omnigent.nova.goals.entities import GoalStatus
from omnigent.nova.goals.service import GOAL_SESSION_LABEL_KEY
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore

ALICE = "alice@example.com"


def _request(
    *, session_id: str, scope: Scope = Scope.PRIVATE, user_id: str = ALICE
) -> ContextRequest:
    return ContextRequest(
        actor=NovaActor(user_id=user_id, workspace_id=0), scope=scope, session_id=session_id
    )


async def test_none_when_scope_is_not_private(goal_runtime: None, db_uri: str) -> None:
    from omnigent.runtime import get_conversation_store

    store = SqlAlchemyGoalStore(db_uri)
    service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    conv = get_conversation_store().create_conversation()

    section = await context_section(_request(session_id=conv.id, scope=Scope.PROJECT))
    assert section is None


async def test_none_when_no_goals(goal_runtime: None, db_uri: str) -> None:
    from omnigent.runtime import get_conversation_store

    conv = get_conversation_store().create_conversation()
    section = await context_section(_request(session_id=conv.id))
    assert section is None


async def test_lists_active_and_paused_goals(goal_runtime: None, db_uri: str) -> None:
    from omnigent.runtime import get_conversation_store

    store = SqlAlchemyGoalStore(db_uri)
    active = service.create_goal(store, user_id=ALICE, title="Active goal", tasks=["a"])
    cancelled = service.create_goal(store, user_id=ALICE, title="Cancelled goal", tasks=["a"])
    service.set_status(store, user_id=ALICE, goal_id=cancelled.id, status=GoalStatus.CANCELLED)
    conv = get_conversation_store().create_conversation()

    section = await context_section(_request(session_id=conv.id))
    assert section is not None
    assert section.key == "goals_active"
    assert section.priority == 30
    assert "Active goal" in section.body
    assert "Cancelled goal" not in section.body
    assert active.id in section.body


async def test_focus_mode_shows_only_that_goal_in_full(goal_runtime: None, db_uri: str) -> None:
    """A session labelled ``nova.goal=<id>`` sees only that Goal, in full."""
    from omnigent.runtime import get_conversation_store

    store = SqlAlchemyGoalStore(db_uri)
    focus_goal = service.create_goal(store, user_id=ALICE, title="Focus goal", tasks=["a"])
    service.create_goal(store, user_id=ALICE, title="Other goal", tasks=["a"])
    conv = get_conversation_store().create_conversation(
        labels={GOAL_SESSION_LABEL_KEY: focus_goal.id}
    )

    section = await context_section(_request(session_id=conv.id))
    assert section is not None
    assert "Focus goal" in section.body
    assert "Other goal" not in section.body


async def test_focus_mode_shows_a_non_active_goal_too(goal_runtime: None, db_uri: str) -> None:
    """The general list hides non-active/paused Goals; single-goal focus does not."""
    from omnigent.runtime import get_conversation_store

    store = SqlAlchemyGoalStore(db_uri)
    goal = service.create_goal(store, user_id=ALICE, title="Done goal", tasks=["a"])
    service.set_status(store, user_id=ALICE, goal_id=goal.id, status=GoalStatus.DONE)
    conv = get_conversation_store().create_conversation(labels={GOAL_SESSION_LABEL_KEY: goal.id})

    section = await context_section(_request(session_id=conv.id))
    assert section is not None
    assert "Done goal" in section.body


async def test_body_is_capped_at_8kb(goal_runtime: None, db_uri: str) -> None:
    store = SqlAlchemyGoalStore(db_uri)
    from omnigent.runtime import get_conversation_store

    for i in range(50):
        service.create_goal(store, user_id=ALICE, title=f"Goal {i} " + "x" * 300, tasks=["a"])
    conv = get_conversation_store().create_conversation()

    section = await context_section(_request(session_id=conv.id))
    assert section is not None
    assert len(section.body.encode("utf-8")) <= 8 * 1024
