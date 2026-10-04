"""Integration tests for ``/v1/suggestions`` and the ``suggestion_*`` runner tools."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from omnigent.runtime.agent_cache import AgentCache
from omnigent.server.app import create_app
from omnigent.stores.agent_store.sqlalchemy_store import SqlAlchemyAgentStore
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.file_store.sqlalchemy_store import SqlAlchemyFileStore
from omnigent.stores.scheduled_task_store.sqlalchemy_store import SqlAlchemyScheduledTaskStore
from omnigent.superchat import _handler_http
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.suggestions.handlers import handle_suggestion_tool

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture()
async def env(
    runtime_init: None, db_uri: str, tmp_path: Path
) -> AsyncIterator[tuple[httpx.AsyncClient, str, str]]:
    artifact_store = LocalArtifactStore(str(tmp_path / "artifacts"))
    conversations = SqlAlchemyConversationStore(db_uri)
    app = create_app(
        agent_store=SqlAlchemyAgentStore(db_uri),
        file_store=SqlAlchemyFileStore(db_uri),
        conversation_store=conversations,
        artifact_store=artifact_store,
        agent_cache=AgentCache(artifact_store=artifact_store, cache_dir=tmp_path / "cache"),
        scheduled_task_store=SqlAlchemyScheduledTaskStore(db_uri),
    )
    chat = conversations.create_conversation().id
    helper = conversations.create_conversation(
        kind="sub_agent", parent_conversation_id=chat, title="analyst:Study"
    ).id
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        yield client, chat, helper


async def test_create_list_patch(env: tuple[httpx.AsyncClient, str, str]) -> None:
    client, chat, _ = env
    body = {
        "parent_session_id": chat,
        "title": "Compare plans",
        "why": "You asked twice.",
        "message": "Compare the two plans.",
    }
    created = await client.post("/v1/suggestions", json=body)
    assert created.status_code == 201, created.text
    item = created.json()
    assert item["status"] == "open" and item["parent_session_id"] == chat

    listed = await client.get(f"/v1/suggestions?parent_session_id={chat}&status=open")
    assert [s["id"] for s in listed.json()["suggestions"]] == [item["id"]]

    done = await client.patch(f"/v1/suggestions/{item['id']}", json={"status": "done"})
    assert done.json()["status"] == "done"
    assert (await client.get("/v1/suggestions?status=open")).json()["suggestions"] == []
    assert (await client.get("/v1/suggestions?status=done")).json()["suggestions"][0][
        "id"
    ] == item["id"]

    bad = await client.patch(f"/v1/suggestions/{item['id']}", json={"status": "weird"})
    assert bad.status_code == 422
    missing = await client.patch(f"/v1/suggestions/{'0' * 32}", json={"status": "done"})
    assert missing.status_code == 404


class _ToolClient:
    """Adapts the in-process test client to the runner's ``server_client`` shape."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def get(self, url: str, *, timeout: object = None) -> httpx.Response:
        return await self._c.get(url)

    async def post(
        self, url: str, *, json: object = None, timeout: object = None
    ) -> httpx.Response:
        return await self._c.post(url, json=json)


async def test_helper_tool_records_under_parent(
    env: tuple[httpx.AsyncClient, str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, chat, helper = env

    async def _kind(session_id: str, _client: object) -> tuple[str, str | None]:
        return ("sub_agent", chat) if session_id == helper else ("default", None)

    monkeypatch.setattr(_handler_http, "session_kind_and_parent", _kind)
    tool_client = _ToolClient(client)
    args = json.dumps(
        {"title": "Draft the memo", "why": "Due Friday.", "message": "Draft the memo."}
    )
    out = json.loads(
        await handle_suggestion_tool(
            HandlerCtx("suggestion_create", tool_client, helper),  # type: ignore[arg-type]
            json.loads(args),
        )
    )
    assert out["parent_session_id"] == chat and out["source_session_id"] == helper
    listed = json.loads(
        await handle_suggestion_tool(
            HandlerCtx("suggestion_list", tool_client, helper),  # type: ignore[arg-type]
            json.loads("{}"),
        )
    )
    assert [s["title"] for s in listed["suggestions"]] == ["Draft the memo"]
    bad = json.loads(
        await handle_suggestion_tool(
            HandlerCtx("suggestion_create", tool_client, chat),  # type: ignore[arg-type]
            json.loads("{}"),
        )
    )
    assert "requires" in bad["error"]
