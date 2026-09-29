"""Integration tests for ``POST /v1/sessions/{id}/builtin-tools/execute``.

Nova's ``nova_*`` tools (memory, goals, episodes, asks, feed, skills) need the
Omnigent database — the conversation store, permission grants, and Nova's own
tables — that a runner process (a person's laptop or a sandbox container) has
no access to. This endpoint runs the tool on the server instead, resolving the
conversation id and caller identity from the session itself rather than
trusting anything a runner could forward.

Uses the same ``auth_app``/``auth_client`` header-impersonation pattern as
``tests/server/integration/test_deployment_context_endpoint.py``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore
from tests.server.conftest import ControllableMockClient
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio

ALICE = "alice@example.com"
BOB = "bob@example.com"


@pytest.fixture(autouse=True)
def _multi_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force multi-user semantics (see ``test_session_agent_owner.py``)."""
    from omnigent.server.routes import _auth_helpers
    from omnigent.server.routes._sessions import orchestration

    monkeypatch.setattr(_auth_helpers, "local_single_user_enabled", lambda: False)
    monkeypatch.setattr(orchestration, "local_single_user_enabled", lambda: False)


@pytest.fixture(autouse=True)
def _reset_nova_memory_store() -> Iterator[None]:
    """Reset Nova memory's process-wide ``_runtime_store`` singleton.

    ``nova_remember`` resolves its store lazily and caches it for the whole
    process (see ``omnigent.nova.memory``'s docstring); without this, a store
    built against one test's ``db_uri`` leaks into the next test's assertions
    (mirrors ``tests/nova/goals/conftest.py``'s ``goal_runtime`` fixture).
    """
    from omnigent.nova import memory

    memory._runtime_store.reset()
    yield
    memory._runtime_store.reset()


@pytest.fixture()
def auth_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    """App with a permission store + header auth provider enabled."""
    from omnigent.server.auth import UnifiedAuthProvider

    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        permission_store=SqlAlchemyPermissionStore(db_uri),
        auth_provider=UnifiedAuthProvider(source="header"),
    )


@pytest_asyncio.fixture()
async def auth_client(
    auth_app: FastAPI,
    mock_llm: ControllableMockClient,
    tmp_path: Path,
) -> AsyncIterator[httpx.AsyncClient]:
    """Async HTTP client wired to the auth-enabled app."""
    from omnigent.runtime import set_harness_process_manager
    from omnigent.runtime.harnesses.process_manager import HarnessProcessManager

    pm = HarnessProcessManager(tmp_parent=tmp_path / "harness_pm")
    await pm.start()
    set_harness_process_manager(pm)

    transport = httpx.ASGITransport(app=auth_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    mock_llm.release_all()
    set_harness_process_manager(None)
    await pm.shutdown()


async def _make_private_session(client: httpx.AsyncClient, name: str, owner: str) -> str:
    agent = await create_test_agent(client, name=name, user=owner)
    session_id = agent["_session_id"]
    resp = await client.patch(
        f"/v1/sessions/{session_id}",
        json={"labels": {"nova.scope": "private"}},
        headers={"X-Forwarded-Email": owner},
    )
    assert resp.status_code == 200, resp.text
    return session_id


# ── authorization ────────────────────────────────────────────────────


async def test_owner_can_run_nova_remember(auth_client: httpx.AsyncClient, db_uri: str) -> None:
    session_id = await _make_private_session(auth_client, "nova-tool-agent", ALICE)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/builtin-tools/execute",
        json={
            "tool_name": "nova_remember",
            "arguments": json.dumps({"content": "Alice prefers oat milk."}),
        },
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 200, resp.text
    output = json.loads(resp.json()["output"])
    assert output["ok"] is True

    from omnigent.nova._shared import NovaActor
    from omnigent.nova.memory import create_store

    store = create_store(db_uri)
    notes = store.list_notes(NovaActor(user_id=ALICE, workspace_id=0))
    assert any("Alice prefers oat milk." in note.content for note in notes)


async def test_other_user_without_grant_is_denied(auth_client: httpx.AsyncClient) -> None:
    """A user with no grant on the session at all gets 404 (no leak)."""
    session_id = await _make_private_session(auth_client, "nova-tool-agent-2", ALICE)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/builtin-tools/execute",
        json={"tool_name": "nova_remember", "arguments": json.dumps({"content": "x"})},
        headers={"X-Forwarded-Email": BOB},
    )
    assert resp.status_code == 404, resp.text


async def test_unknown_session_returns_404(auth_client: httpx.AsyncClient) -> None:
    resp = await auth_client.post(
        "/v1/sessions/conv_nonexistent_abc123/builtin-tools/execute",
        json={"tool_name": "nova_remember", "arguments": "{}"},
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 404, resp.text


async def test_non_server_builtin_tool_name_is_rejected(auth_client: httpx.AsyncClient) -> None:
    """Only ``SERVER_BUILTIN_NAMES`` may run through this endpoint — it is not
    a general "run any builtin as the owner" backdoor."""
    session_id = await _make_private_session(auth_client, "nova-tool-agent-3", ALICE)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/builtin-tools/execute",
        json={"tool_name": "sys_os_shell", "arguments": "{}"},
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 400, resp.text


async def test_tool_uses_server_resolved_conversation_id(
    auth_client: httpx.AsyncClient, db_uri: str
) -> None:
    """The written note is scoped to the session actually named in the URL —
    a runner could not point the write at an arbitrary session."""
    session_id = await _make_private_session(auth_client, "nova-tool-agent-4", ALICE)

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/builtin-tools/execute",
        json={
            "tool_name": "nova_remember",
            "arguments": json.dumps({"content": "Server-resolved conversation id works."}),
        },
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 200, resp.text

    from omnigent.nova._shared import NovaActor
    from omnigent.nova.memory import create_store

    store = create_store(db_uri)
    notes = store.list_notes(NovaActor(user_id=ALICE, workspace_id=0))
    assert any("Server-resolved conversation id works." in note.content for note in notes)
