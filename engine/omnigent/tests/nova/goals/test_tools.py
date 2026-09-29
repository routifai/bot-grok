"""Tests for the ``nova_goals`` built-in tool.

Exercises owner resolution from ``ToolContext.conversation_id`` (private
scope only, via the real :class:`ConversationStore` + permission grants) and
the three actions (``create``, ``propose``, ``update_task``).
"""

from __future__ import annotations

import json

from omnigent.nova.goals import service
from omnigent.nova.goals.entities import TaskStatus
from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore
from omnigent.nova.goals.tools import TOOLS, NovaGoalsTool
from omnigent.tools.base import ToolContext

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _owned_conversation(
    db_uri: str, *, user_id: str = ALICE, labels: dict[str, str] | None = None
) -> str:
    """Create a conversation owned (LEVEL_OWNER) by ``user_id``; returns its id."""
    from omnigent.runtime import get_conversation_store
    from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore

    conv = get_conversation_store().create_conversation(labels=labels)
    perms = SqlAlchemyPermissionStore(db_uri)
    perms.ensure_user(user_id)
    perms.grant(user_id, conv.id, 4)  # LEVEL_OWNER
    return conv.id


def _ctx(conversation_id: str | None) -> ToolContext:
    return ToolContext(task_id="task1", agent_id="agent1", conversation_id=conversation_id)


def test_registered_under_nova_goals() -> None:
    assert "nova_goals" in TOOLS
    assert isinstance(TOOLS["nova_goals"]({}), NovaGoalsTool)


def test_refuses_without_a_conversation(goal_runtime: None) -> None:
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(json.dumps({"action": "create", "title": "x", "tasks": ["a"]}), _ctx(None))
    )
    assert "error" in result


def test_refuses_in_project_scope(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, labels={"nova.scope": "project"})
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(json.dumps({"action": "create", "title": "x", "tasks": ["a"]}), _ctx(conv_id))
    )
    assert "error" in result


def test_refuses_with_no_owner(goal_runtime: None) -> None:
    from omnigent.runtime import get_conversation_store

    conv = get_conversation_store().create_conversation()  # no permission grants at all
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(json.dumps({"action": "create", "title": "x", "tasks": ["a"]}), _ctx(conv.id))
    )
    assert "error" in result


def test_create_action(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps(
                {"action": "create", "title": "Learn guitar", "tasks": ["Buy one", "Practice"]}
            ),
            _ctx(conv_id),
        )
    )
    assert "error" not in result
    goal = result["goal"]
    assert goal["title"] == "Learn guitar"
    assert goal["open_proposal"]["reason"] == "First plan"

    # Persisted under the resolved owner, not some other identity.
    store = SqlAlchemyGoalStore(db_uri)
    assert store.get(goal["id"], user_id=ALICE) is not None
    assert store.get(goal["id"], user_id=BOB) is None


def test_create_requires_a_title(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(json.dumps({"action": "create", "title": "  ", "tasks": ["a"]}), _ctx(conv_id))
    )
    assert "error" in result


def test_propose_action(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    store = SqlAlchemyGoalStore(db_uri)
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])

    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps(
                {
                    "action": "propose",
                    "goal_id": goal.id,
                    "reason": "Try something else",
                    "tasks": [{"title": "b"}],
                }
            ),
            _ctx(conv_id),
        )
    )
    assert "error" not in result
    assert result["goal"]["open_proposal"]["reason"] == "Try something else"


def test_propose_requires_goal_id(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps({"action": "propose", "reason": "x", "tasks": [{"title": "a"}]}),
            _ctx(conv_id),
        )
    )
    assert "error" in result


def test_propose_for_someone_elses_goal_is_not_found(goal_runtime: None, db_uri: str) -> None:
    store = SqlAlchemyGoalStore(db_uri)
    goal = service.create_goal(store, user_id=BOB, title="Bob's goal", tasks=["a"])
    conv_id = _owned_conversation(db_uri, user_id=ALICE)

    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps(
                {"action": "propose", "goal_id": goal.id, "reason": "x", "tasks": [{"title": "a"}]}
            ),
            _ctx(conv_id),
        )
    )
    assert "error" in result


def test_update_task_action_and_became_blocked(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    store = SqlAlchemyGoalStore(db_uri)
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]
    task = goal.tasks[0]

    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps(
                {
                    "action": "update_task",
                    "goal_id": goal.id,
                    "task_id": task.id,
                    "status": "blocked",
                    "note": "waiting on a part",
                }
            ),
            _ctx(conv_id),
        )
    )
    assert "error" not in result
    assert result["became_blocked"] is True
    assert result["goal"]["tasks"][0]["status"] == TaskStatus.BLOCKED.value


def test_update_task_rejects_unknown_status(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    store = SqlAlchemyGoalStore(db_uri)
    goal = service.create_goal(store, user_id=ALICE, title="Goal", tasks=["a"])
    goal = service.accept_proposal(store, user_id=ALICE, proposal_id=goal.open_proposal.id)  # type: ignore[union-attr]

    tool = NovaGoalsTool()
    result = json.loads(
        tool.invoke(
            json.dumps(
                {
                    "action": "update_task",
                    "goal_id": goal.id,
                    "task_id": goal.tasks[0].id,
                    "status": "not-a-real-status",
                }
            ),
            _ctx(conv_id),
        )
    )
    assert "error" in result


def test_unknown_action_is_rejected(goal_runtime: None, db_uri: str) -> None:
    conv_id = _owned_conversation(db_uri, user_id=ALICE)
    tool = NovaGoalsTool()
    result = json.loads(tool.invoke(json.dumps({"action": "delete_everything"}), _ctx(conv_id)))
    assert "error" in result


def test_schema_declares_actions_and_is_named_nova_goals() -> None:
    tool = NovaGoalsTool()
    schema = tool.get_schema()
    assert schema["function"]["name"] == "nova_goals"
    assert set(schema["function"]["parameters"]["properties"]["action"]["enum"]) == {
        "create",
        "propose",
        "update_task",
    }
