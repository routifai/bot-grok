"""Integration tests for ``POST /v1/sessions/{id}/deployment-context``.

The runner used to call the ``OMNIGENT_CONTEXT_PROVIDER_URL`` hook directly,
which meant it had to hold ``OMNIGENT_CONTEXT_PROVIDER_SECRET`` — unsafe for
a runner that can be a user's own laptop (``omnigent host``). This endpoint
moves that call to the server: the runner POSTs turn-local fields it already
knows (``agent_name``, ``harness``, ``turn_input``) and the server resolves
the session's owner and labels itself from its own stores rather than
trusting values a runner could supply for an arbitrary session.

Uses the same ``auth_app``/``auth_client`` header-impersonation pattern as
``tests/server/integration/test_session_agent_owner.py`` (a real
``SqlAlchemyPermissionStore`` + header ``AuthProvider``, ``X-Forwarded-Email``
impersonates the caller) so the authorization mirrors the sibling
``GET /sessions/{id}/labels`` runner callback exactly: any caller with at
least ``LEVEL_READ`` on the session is allowed, and the server never trusts
runner-supplied identity/labels.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import respx
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
_PROVIDER_URL = "https://provider.test/context"


@pytest.fixture(autouse=True)
def _multi_user(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force multi-user semantics (see ``test_session_agent_owner.py``)."""
    from omnigent.server.routes import _auth_helpers
    from omnigent.server.routes._sessions import orchestration

    monkeypatch.setattr(_auth_helpers, "local_single_user_enabled", lambda: False)
    monkeypatch.setattr(orchestration, "local_single_user_enabled", lambda: False)


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


async def _set_labels(
    client: httpx.AsyncClient, session_id: str, owner: str, labels: dict[str, str]
) -> None:
    resp = await client.patch(
        f"/v1/sessions/{session_id}",
        json={"labels": labels},
        headers={"X-Forwarded-Email": owner},
    )
    assert resp.status_code == 200, resp.text


# ── authorization ────────────────────────────────────────────────────


async def test_bound_runner_i_e_owner_gets_a_block(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The session owner (what a bound runner authenticates as) is allowed."""
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _PROVIDER_URL)
    agent = await create_test_agent(auth_client, name="ctx-agent", user=ALICE)
    session_id = agent["_session_id"]

    with respx.mock:
        respx.post(_PROVIDER_URL).mock(
            return_value=httpx.Response(200, json={"instructions": "be careful"})
        )
        resp = await auth_client.post(
            f"/v1/sessions/{session_id}/deployment-context",
            json={"agent_name": "research-agent", "harness": "pi", "turn_input": "hi"},
            headers={"X-Forwarded-Email": ALICE},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["block"] == "\n\n<deployment_context>\nbe careful\n</deployment_context>"


async def test_other_user_without_grant_is_denied(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user with no grant on the session at all gets 404 (no leak)."""
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _PROVIDER_URL)
    agent = await create_test_agent(auth_client, name="ctx-agent-2", user=ALICE)
    session_id = agent["_session_id"]

    resp = await auth_client.post(
        f"/v1/sessions/{session_id}/deployment-context",
        json={"agent_name": "a", "harness": "pi", "turn_input": "hi"},
        headers={"X-Forwarded-Email": BOB},
    )
    assert resp.status_code == 404, resp.text


async def test_unknown_session_returns_404(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _PROVIDER_URL)
    resp = await auth_client.post(
        "/v1/sessions/conv_nonexistent_abc123/deployment-context",
        json={"agent_name": "a", "harness": "pi", "turn_input": "hi"},
        headers={"X-Forwarded-Email": ALICE},
    )
    assert resp.status_code == 404, resp.text


# ── provider unset ───────────────────────────────────────────────────


async def test_provider_unset_returns_empty_block(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No provider configured: ``{"block": ""}``, and the provider is never called."""
    monkeypatch.delenv("OMNIGENT_CONTEXT_PROVIDER_URL", raising=False)
    agent = await create_test_agent(auth_client, name="ctx-agent-3", user=ALICE)
    session_id = agent["_session_id"]

    with respx.mock:
        # No route registered — any outbound HTTP call would raise.
        resp = await auth_client.post(
            f"/v1/sessions/{session_id}/deployment-context",
            json={"agent_name": "a", "harness": "pi", "turn_input": "hi"},
            headers={"X-Forwarded-Email": ALICE},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["block"] == ""


# ── server resolves owner + labels; runner-supplied values are ignored ─


async def test_server_resolves_owner_and_labels_not_the_request_body(
    auth_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The request schema has no ``user_id``/``labels`` fields at all — even
    if a caller stuffs them into the JSON body, the provider sees the
    server's own resolved owner and labels, not anything from the runner.
    """
    monkeypatch.setenv("OMNIGENT_CONTEXT_PROVIDER_URL", _PROVIDER_URL)
    agent = await create_test_agent(auth_client, name="ctx-agent-4", user=ALICE)
    session_id = agent["_session_id"]
    await _set_labels(auth_client, session_id, ALICE, {"team": "growth"})

    captured: dict[str, object] = {}

    def _responder(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"instructions": "hi"})

    with respx.mock:
        respx.post(_PROVIDER_URL).mock(side_effect=_responder)
        resp = await auth_client.post(
            f"/v1/sessions/{session_id}/deployment-context",
            # A hostile/confused runner stuffing in spoofed identity/labels —
            # the endpoint's schema doesn't even accept these fields.
            json={
                "agent_name": "a",
                "harness": "pi",
                "turn_input": "hi",
                "user_id": "attacker@example.com",
                "labels": {"team": "spoofed"},
            },
            headers={"X-Forwarded-Email": ALICE},
        )
    assert resp.status_code == 200, resp.text
    body = captured["body"]
    assert body["user_id"] == ALICE
    assert body["labels"]["team"] == "growth"
