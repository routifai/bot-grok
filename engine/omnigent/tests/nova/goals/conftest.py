"""Shared fixtures for the Goals primitive's tests."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

from omnigent.nova.goals.sqlalchemy_store import SqlAlchemyGoalStore


def uid(seed: str) -> str:
    """Deterministic bare 32-char hex id from a short readable seed.

    ``nova_goals``/``nova_goal_tasks``/``nova_goal_proposals`` primary keys
    are ``Uuid16`` columns (see ``omnigent/nova/goals/tables.py``) — they
    accept only a 32-char hex uuid, never an arbitrary string like ``"g1"``.
    Mirrors ``tests/stores/test_project_store.py``'s ``_uid`` helper for the
    same reason: tests stay legible while still round-tripping real ids.
    """
    return uuid.uuid5(uuid.NAMESPACE_DNS, seed).hex


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyGoalStore:
    """A fresh :class:`SqlAlchemyGoalStore` backed by the per-test SQLite DB."""
    return SqlAlchemyGoalStore(db_uri)


@pytest.fixture()
def goal_runtime(db_uri: str, tmp_path: Path) -> Iterator[None]:
    """
    Initialize ``omnigent.runtime`` with real stores pointed at ``db_uri``.

    ``tools.py`` and ``context.py`` resolve a person's identity and build
    their store via ``omnigent.nova.goals._runtime_store()`` (see those
    modules' docstrings) — this fixture is the minimal
    ``omnigent.runtime.init()`` call that makes that accessor work in a test,
    trimmed from ``tests/server/conftest.py``'s heavier ``runtime_init``
    (no mock LLM: these tests never run a full agent turn).

    Also resets the process-wide ``_runtime_store`` singleton before and
    after, so a store built against one test's ``db_uri`` never leaks into
    the next (mirrors ``omnigent.nova.memory``'s own fixture).
    """
    from omnigent import runtime
    from omnigent.nova import goals
    from omnigent.runtime.agent_cache import AgentCache
    from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
    from omnigent.stores.artifact_store.local import LocalArtifactStore
    from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

    goals._store = None
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    runtime.init(
        conversation_store=SqlAlchemyConversationStore(db_uri),
        agent_store=SqlAlchemyAgentStore(db_uri),
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        artifact_store=artifact_store,
    )
    try:
        yield
    finally:
        goals._store = None
