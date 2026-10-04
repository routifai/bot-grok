"""Integration tests for ``/v1/taught-skills`` and the ``skill_*`` runner tools."""

from __future__ import annotations

import json
import uuid
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
from omnigent.superchat.taught_skills.handlers import handle_taught_skill_tool

pytestmark = pytest.mark.asyncio

DRAFT = {
    "name": "Search a product",
    "goal": "Find a product",
    "inputs": [{"name": "product", "default": "laptop stand"}],
    "steps": [
        {"intent": "Search for {{product}}", "check": "Results appear", "keyframe": "k1"},
        {"intent": "Buy it", "check": "Receipt shown", "approval": True, "keyframe": "k9"},
    ],
}


class Env:
    def __init__(self, client: httpx.AsyncClient, chat: str, helper: str, skill: str, rec: str):
        self.client, self.chat, self.helper, self.skill, self.rec = (
            client,
            chat,
            helper,
            skill,
            rec,
        )


@pytest_asyncio.fixture()
async def env(runtime_init: None, db_uri: str, tmp_path: Path) -> AsyncIterator[Env]:
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
        kind="sub_agent", parent_conversation_id=chat, title="teacher:Learn"
    ).id
    store = app.state.taught_skill_store
    rec, skill = uuid.uuid4().hex, uuid.uuid4().hex
    store.start_recording(rec, skill, user_id=None, session_id=chat, goal="search shoes")
    store.finish_recording(rec, actions=[{"seq": 1}], keyframes={"k1": b"\xff\xd8jpeg"})
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        yield Env(client, chat, helper, skill, rec)


class _ToolClient:
    def __init__(self, client: httpx.AsyncClient) -> None:
        self._c = client

    async def get(self, url: str, *, timeout: object = None) -> httpx.Response:
        return await self._c.get(url)

    async def post(self, url: str, *, json: object = None, timeout: object = None):
        return await self._c.post(url, json=json)

    async def put(self, url: str, *, json: object = None, timeout: object = None):
        return await self._c.put(url, json=json)


async def test_draft_edit_save_render_delete(env: Env) -> None:
    c, base = env.client, f"/v1/taught-skills/{env.skill}"
    got = (await c.get(base)).json()
    assert got["status"] == "drafting" and got["keyframes"] == ["k1"] and got["doc"] is None

    put = await c.put(f"{base}/doc", json={"doc": DRAFT})
    assert put.status_code == 200, put.text
    body = put.json()
    assert body["status"] == "draft" and body["version"] == 1 and body["name"] == DRAFT["name"]
    assert [s["keyframe"] for s in body["doc"]["steps"]] == ["k1", None]  # k9 does not exist
    assert (await c.put(f"{base}/doc", json={"doc": {"name": "x"}})).status_code == 400

    kf = await c.get(f"{base}/keyframes/k1")
    assert kf.headers["content-type"] == "image/jpeg" and kf.content == b"\xff\xd8jpeg"
    assert (await c.get(f"{base}/keyframes/k5")).status_code == 404

    assert (await c.post(f"{base}/save")).json()["status"] == "saved"
    listed = await c.get(f"/v1/taught-skills?parent_session_id={env.chat}&status=saved")
    assert [s["id"] for s in listed.json()["skills"]] == [env.skill]

    run = (await c.post(f"{base}/render", json={"inputs": {"product": "desk lamp"}})).json()
    assert "1. Search for desk lamp" in run["text"] and run["missing_inputs"] == []
    default = (await c.post(f"{base}/render", json={})).json()
    assert "laptop stand" in default["text"]
    wrong = await c.post(f"{base}/render", json={"parent_session_id": uuid.uuid4().hex})
    assert wrong.status_code == 404

    assert (await c.delete(base)).status_code == 204
    assert (await c.get(base)).status_code == 404
    assert (await c.get(f"{base}/keyframes/k1")).status_code == 404


async def test_render_requires_a_draft_and_unknown_ids_404(env: Env) -> None:
    c = env.client
    assert (await c.post(f"/v1/taught-skills/{env.skill}/render", json={})).status_code == 409
    assert (await c.post(f"/v1/taught-skills/{env.skill}/save")).status_code == 409
    assert (await c.get(f"/v1/taught-skills/{'0' * 32}")).status_code == 404
    assert (await c.get("/v1/taught-skills/not-an-id")).status_code == 400


async def test_tools_helper_drafts_and_muse_runs(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def _kind(session_id: str, _client: object) -> tuple[str, str | None]:
        return ("sub_agent", env.chat) if session_id == env.helper else ("default", None)

    monkeypatch.setattr(_handler_http, "session_kind_and_parent", _kind)
    tc = _ToolClient(env.client)

    async def call(tool: str, args: dict, who: str) -> dict:
        out = await handle_taught_skill_tool(
            HandlerCtx(tool, tc, who),  # type: ignore[arg-type]
            json.loads(json.dumps(args)),
        )
        return json.loads(out)

    saved = await call("skill_draft_save", {**DRAFT, "skill_id": env.skill}, env.helper)
    assert saved["status"] == "draft"
    assert "only for the Helper" in (await call("skill_draft_save", {}, env.chat))["error"]
    assert "not available" in (await call("skill_list", {}, env.helper))["error"]
    assert (await call("skill_list", {}, env.chat))["skills"] == []

    await env.client.post(f"/v1/taught-skills/{env.skill}/save")
    listed = await call("skill_list", {}, env.chat)
    assert [s["name"] for s in listed["skills"]] == ["Search a product"]
    by_name = await call(
        "skill_run", {"skill": "search a product", "inputs": {"product": "x"}}, env.chat
    )
    assert "1. Search for x" in by_name["text"]
    by_id = await call("skill_run", {"skill": env.skill}, env.chat)
    assert by_id["skill_id"] == env.skill
    assert "no saved skill" in (await call("skill_run", {"skill": "nope"}, env.chat))["error"]

    other = uuid.uuid4().hex
    foreign = await call("skill_draft_save", {**DRAFT, "skill_id": other}, env.helper)
    assert "error" in foreign
