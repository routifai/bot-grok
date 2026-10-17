"""Family reads on the items routes: POST .../read and search across a Conversation."""

from __future__ import annotations

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.server.routes._sessions.helpers import _prune_session_read_state
from omnigent.server.routes.sessions.routes_items import register_items_routes
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore

_MODE = {"omnigent.context.mode": "superside-chat"}


def _say(role: str, text: str, response_id: str = "r1") -> NewConversationItem:
    content = [{"type": "input_text" if role == "user" else "output_text", "text": text}]
    return NewConversationItem(
        type="message",
        response_id=response_id,
        data=MessageData(
            role=role, content=content, agent="brain" if role == "assistant" else None
        ),
    )


@pytest.fixture()
async def client(conversation_store: SqlAlchemyConversationStore) -> httpx.AsyncClient:
    app = FastAPI()
    router = APIRouter()
    register_items_routes(
        router,
        conversation_store=conversation_store,
        agent_store=None,  # type: ignore[arg-type]
    )
    app.include_router(router, prefix="/v1")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
        yield http


def _root(store: SqlAlchemyConversationStore) -> str:
    return store.create_conversation(kind="default", title="S", labels=_MODE).id


async def test_read_moves_the_baseline_forward_only(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id = _root(conversation_store)
    try:
        conversation_store.append(root_id, [_say("user", "hi"), _say("assistant", "hello")])
        read = (await client.post(f"/v1/sessions/{root_id}/read")).json()
        assert read["unread"] is False and read["session_id"] == root_id

        # Reading up to an older item never moves the baseline back.
        first = conversation_store.list_items(root_id, limit=1).data[0]
        again = await client.post(f"/v1/sessions/{root_id}/read", json={"item_id": first.id})
        assert again.json()["last_read_at"] == read["last_read_at"]
    finally:
        _prune_session_read_state(root_id)


async def test_read_rejects_an_unknown_item_and_session(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id = _root(conversation_store)
    with pytest.raises(OmnigentError, match="Item not found"):
        await client.post(f"/v1/sessions/{root_id}/read", json={"item_id": "msg_nope"})
    with pytest.raises(OmnigentError, match="not found"):
        await client.post("/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/read")


async def test_family_search_covers_the_conversation_skips_hidden_and_helpers(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id = _root(conversation_store)
    helper = conversation_store.create_conversation(
        kind="sub_agent", parent_conversation_id=root_id, title="job", labels=_MODE
    )
    hidden = NewConversationItem(
        type="message",
        response_id="r1",
        data=MessageData(
            role="user", content=[{"type": "input_text", "text": "zebra hidden"}], is_meta=True
        ),
    )
    conversation_store.append(
        root_id, [_say("user", "zebra in the root"), _say("assistant", "zebra reply"), hidden]
    )
    conversation_store.append(helper.id, [_say("assistant", "zebra in helper")])

    body = (
        await client.get(
            f"/v1/sessions/{root_id}/items/search", params={"query": "zebra", "scope": "family"}
        )
    ).json()
    hits = {(hit["session_id"], hit["text"]) for hit in body["data"]}
    assert hits == {(root_id, "zebra in the root"), (root_id, "zebra reply")}
    for hit in body["data"]:
        assert hit["message_id"] == hit["item"]["id"]
        assert hit["role"] in ("user", "assistant")

    # The default scope is unchanged: this session's items only.
    own = (
        await client.get(f"/v1/sessions/{root_id}/items/search", params={"query": "zebra"})
    ).json()
    assert [item["id"] for item in own["data"]] and "session_id" not in own["data"][0]
