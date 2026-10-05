"""Integration tests for the Activity Feed routes.

``GET /v1/sessions/{id}/activities`` and
``GET /v1/sessions/{id}/activities/{activity_id}`` — the owner-scoped,
READ-gated wrapper around ``omnigent.superchat.activity.derive`` (derivation
unit-tested directly in tests/superchat/). These tests cover the route
wiring: auth/404 handling and the end-to-end shape over a seeded
Super Chat + Sub-agent.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from omnigent.entities import FunctionCallData, MessageData, NewConversationItem
from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.server.auth import LEVEL_OWNER, LEVEL_READ, UnifiedAuthProvider
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.comment_store.sqlalchemy_store import SqlAlchemyCommentStore
from omnigent.stores.conversation_store import FORK_SOURCE_LABEL_KEY, SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import (
    SqlAlchemyConversationStore,
)
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.permission_store.sqlalchemy_store import (
    SqlAlchemyPermissionStore,
)
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio

_MODE_LABEL = "omnigent.context.mode"
_MODE_VALUE = "superside-chat"


async def _create_session(client: httpx.AsyncClient, agent_name: str) -> dict[str, Any]:
    agent = await create_test_agent(client, name=agent_name)
    resp = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert resp.status_code == 201, f"session create failed: {resp.text}"
    return resp.json()


# ── 404 ──────────────────────────────────────────────────────────────────


async def test_activities_404_for_nonexistent_session(client: httpx.AsyncClient) -> None:
    resp = await client.get("/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/activities")
    assert resp.status_code == 404


async def test_activity_detail_404_for_nonexistent_session(client: httpx.AsyncClient) -> None:
    resp = await client.get(
        "/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/activities/sub_agent:conv_x"
    )
    assert resp.status_code == 404


async def test_server_marks_a_new_child_session_as_launching(
    client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    conv_store = SqlAlchemyConversationStore(db_uri)
    parent = await _create_session(client, "launch-parent")
    created = await client.post(
        "/v1/sessions",
        json={
            "agent_id": parent["agent_id"],
            "parent_session_id": parent["id"],
            "initial_items": [],
        },
    )
    assert created.status_code == 201, created.text
    child = conv_store.get_conversation(created.json()["id"])
    assert child is not None
    assert child.labels.get("omnigent.subagent.launching") == "true"
    top = conv_store.get_conversation(parent["id"])
    assert top is not None
    assert "omnigent.subagent.launching" not in top.labels


async def test_activity_changes_stream_404_for_nonexistent_session(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get("/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/activities/stream")
    assert resp.status_code == 404


async def test_activity_changes_stream_is_not_taken_for_an_activity_id(
    client: httpx.AsyncClient,
) -> None:
    # A plain session has no feed to watch: the stream route answers (and ends) as a
    # stream, rather than the detail route reading "stream" as an unknown activity id.
    session = await _create_session(client, "plain-stream-agent")
    resp = await client.get(f"/v1/sessions/{session['id']}/activities/stream")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.text == ""


# ── Non-superside-chat session: empty, not an error ──────────────────────


async def test_activities_empty_for_plain_session(client: httpx.AsyncClient) -> None:
    session = await _create_session(client, "plain-agent")
    resp = await client.get(f"/v1/sessions/{session['id']}/activities")
    assert resp.status_code == 200
    body = resp.json()
    assert body["object"] == "list"
    assert body["data"] == []


# ── Full shape over a seeded Super Chat + Sub-agent ───────────────────────


async def test_activities_list_and_detail_for_superside_chat_session(
    client: httpx.AsyncClient,
    db_uri: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("omnigent.superchat.activity.derive._MIN_TURN_STEPS", 1)
    session = await _create_session(client, "superside-agent")
    conv_store = SqlAlchemyConversationStore(db_uri)
    conv_store.set_labels(session["id"], {_MODE_LABEL: _MODE_VALUE})

    response_id = "resp_1"
    conv_store.append(
        session["id"],
        [
            NewConversationItem(
                type="message",
                response_id=response_id,
                data=MessageData(
                    role="user",
                    content=[{"type": "input_text", "text": "research side chat mechanics"}],
                ),
            ),
            NewConversationItem(
                type="function_call",
                response_id=response_id,
                data=FunctionCallData(
                    agent="brain",
                    name="memory_search",
                    arguments=json.dumps({"query": "side chat"}),
                    call_id="call_1",
                ),
            ),
            NewConversationItem(
                type="message",
                response_id=response_id,
                data=MessageData(
                    role="assistant",
                    agent="brain",
                    content=[{"type": "output_text", "text": "Researched side chat mechanics"}],
                ),
            ),
        ],
    )
    sub_agent = conv_store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=session["id"],
        title="researcher:auth-flow",
        labels={_MODE_LABEL: _MODE_VALUE},
    )
    conv_store.set_session_live_status(sub_agent.id, "idle")

    list_resp = await client.get(f"/v1/sessions/{session['id']}/activities")
    assert list_resp.status_code == 200
    rows = list_resp.json()["data"]
    assert len(rows) == 2
    by_kind = {row["kind"]: row for row in rows}

    turn = by_kind["turn"]
    assert turn["chat_id"] == session["id"]
    assert turn["outcome"] == "Researched side chat mechanics"
    assert turn["status"] == "done"
    assert "date" in turn
    assert turn["steps"][0]["title"] == "Searched memory for 'side chat'"
    assert "detail" not in turn["steps"][0]

    sub = by_kind["sub_agent"]
    assert sub["chat_id"] == sub_agent.id
    assert sub["title"] == "auth-flow"
    assert sub["status"] == "done"

    detail_resp = await client.get(f"/v1/sessions/{session['id']}/activities/{sub['id']}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["id"] == sub["id"]
    assert detail["steps"] == []  # the seeded sub-agent had no tool calls


async def test_activity_detail_404_for_unknown_activity_id(
    client: httpx.AsyncClient,
    db_uri: str,
) -> None:
    session = await _create_session(client, "superside-agent-2")
    conv_store = SqlAlchemyConversationStore(db_uri)
    conv_store.set_labels(session["id"], {_MODE_LABEL: _MODE_VALUE})

    resp = await client.get(f"/v1/sessions/{session['id']}/activities/sub_agent:conv_missing")
    assert resp.status_code == 404


# ── Family leak: a caller shared only one Side Chat of the family must
# never see the Super Chat's or a sibling's activities ───────────────────


@pytest.fixture()
def auth_app(runtime_init: None, db_uri: str, tmp_path: Path) -> FastAPI:
    """App with header-mode auth + permission_store so access is gated."""
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    return create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=SqlAlchemyConversationStore(db_uri),
        artifact_store=artifact_store,
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        comment_store=SqlAlchemyCommentStore(db_uri),
        permission_store=SqlAlchemyPermissionStore(db_uri),
        auth_provider=UnifiedAuthProvider(source="header"),
    )


@pytest_asyncio.fixture()
async def auth_client(auth_app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=auth_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_activities_hide_family_members_the_caller_cannot_read(
    auth_client: httpx.AsyncClient, db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bob has READ on one Side Chat only; the Super Chat's and the other
    Side Chat's own activities must not leak into Bob's feed."""
    monkeypatch.setattr("omnigent.superchat.activity.derive._MIN_TURN_STEPS", 1)
    conv_store = SqlAlchemyConversationStore(db_uri)
    perm_store = SqlAlchemyPermissionStore(db_uri)

    super_chat = conv_store.create_conversation(labels={_MODE_LABEL: _MODE_VALUE})
    side_a = conv_store.create_conversation(
        labels={
            _MODE_LABEL: _MODE_VALUE,
            FORK_SOURCE_LABEL_KEY: super_chat.id,
            SIDE_CHAT_LABEL_KEY: "1",
        }
    )
    side_b = conv_store.create_conversation(
        labels={
            _MODE_LABEL: _MODE_VALUE,
            FORK_SOURCE_LABEL_KEY: super_chat.id,
            SIDE_CHAT_LABEL_KEY: "1",
        }
    )
    for conv, text in ((super_chat, "super chat turn"), (side_b, "side b turn")):
        conv_store.append(
            conv.id,
            [
                NewConversationItem(
                    type="message",
                    response_id=f"resp_{conv.id}",
                    data=MessageData(role="user", content=[{"type": "input_text", "text": text}]),
                ),
                NewConversationItem(
                    type="function_call",
                    response_id=f"resp_{conv.id}",
                    data=FunctionCallData(
                        agent="brain",
                        name="memory_search",
                        arguments=json.dumps({"query": text}),
                        call_id=f"call_{conv.id}",
                    ),
                ),
            ],
        )

    alice, bob = "alice@example.com", "bob@example.com"
    perm_store.ensure_user(alice)
    perm_store.ensure_user(bob)
    for conv in (super_chat, side_a, side_b):
        perm_store.grant(alice, conv.id, LEVEL_OWNER)
    perm_store.grant(bob, side_a.id, LEVEL_READ)

    list_resp = await auth_client.get(
        f"/v1/sessions/{side_a.id}/activities",
        headers={"X-Forwarded-Email": bob},
    )
    assert list_resp.status_code == 200, list_resp.text
    chat_ids = {row["chat_id"] for row in list_resp.json()["data"]}
    assert super_chat.id not in chat_ids
    assert side_b.id not in chat_ids

    # Alice, the owner, still sees the whole family.
    alice_resp = await auth_client.get(
        f"/v1/sessions/{side_a.id}/activities",
        headers={"X-Forwarded-Email": alice},
    )
    assert alice_resp.status_code == 200, alice_resp.text
    alice_chat_ids = {row["chat_id"] for row in alice_resp.json()["data"]}
    assert super_chat.id in alice_chat_ids
    assert side_b.id in alice_chat_ids
