"""Family reads on the items routes: per-viewer unread on related_chats, POST .../read, and
search across a Conversation and its Side Chats."""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from omnigent.entities import CompactionData, MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.server.routes._sessions.helpers import _prune_session_read_state
from omnigent.server.routes.sessions.routes_items import register_items_routes
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
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


def _family(store: SqlAlchemyConversationStore, start: str = "blank") -> tuple[str, str]:
    root = store.create_conversation(kind="default", title="S", labels=_MODE)
    side = store.create_conversation(
        kind="default",
        title="Side",
        labels={
            **_MODE,
            SIDE_CHAT_LABEL_KEY: "true",
            "omnigent.side_chat.parent_id": root.id,
            "omnigent.side_chat.start": start,
        },
    )
    return root.id, side.id


async def _side_row(client: httpx.AsyncClient, root_id: str, side_id: str) -> dict[str, Any]:
    rows = (await client.get(f"/v1/sessions/{root_id}/related_chats")).json()["data"]
    return next(row for row in rows if row["id"] == side_id)


async def test_a_reply_makes_the_chat_unread_until_it_is_read(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id, side_id = _family(conversation_store)
    try:
        conversation_store.append(side_id, [_say("user", "hi")])
        row = await _side_row(client, root_id, side_id)
        assert row["unread"] is False and row["last_read_at"] is None  # no reply yet

        conversation_store.append(side_id, [_say("assistant", "hello")])
        assert (await _side_row(client, root_id, side_id))["unread"] is True

        read = (await client.post(f"/v1/sessions/{side_id}/read")).json()
        assert read["unread"] is False and read["session_id"] == side_id
        row = await _side_row(client, root_id, side_id)
        assert row["unread"] is False and row["last_read_at"] == read["last_read_at"]

        # Reading up to an older item never moves the baseline back.
        first = conversation_store.list_items(side_id, limit=1).data[0]
        again = await client.post(f"/v1/sessions/{side_id}/read", json={"item_id": first.id})
        assert again.json()["last_read_at"] == read["last_read_at"]

        # A newer reply flips it back (baseline pinned in the past to avoid a same-second tie).
        from omnigent.server.routes._sessions.helpers import _set_read_state

        _set_read_state(None, side_id, read["last_read_at"] - 10, False)
        conversation_store.append(side_id, [_say("assistant", "more")])
        assert (await _side_row(client, root_id, side_id))["unread"] is True
    finally:
        _prune_session_read_state(side_id)


async def test_read_rejects_an_unknown_item_and_session(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id, _ = _family(conversation_store)
    with pytest.raises(OmnigentError, match="Item not found"):
        await client.post(f"/v1/sessions/{root_id}/read", json={"item_id": "msg_nope"})
    with pytest.raises(OmnigentError, match="not found"):
        await client.post("/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/read")


async def test_family_search_covers_chats_skips_copies_hidden_and_helpers(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root_id, side_id = _family(conversation_store, start="with_context")
    helper = conversation_store.create_conversation(
        kind="sub_agent", parent_conversation_id=root_id, title="job", labels=_MODE
    )
    conversation_store.append(root_id, [_say("user", "zebra in the root")])
    seed = NewConversationItem(
        type="compaction",
        response_id=f"rollover_seed_{side_id}",
        data=CompactionData(summary="s", last_item_id="x", token_count=1),
    )
    hidden = NewConversationItem(
        type="message",
        response_id="r1",
        data=MessageData(
            role="user", content=[{"type": "input_text", "text": "zebra hidden"}], is_meta=True
        ),
    )
    conversation_store.append(
        side_id,
        [_say("user", "zebra in the root"), seed, _say("assistant", "zebra in side"), hidden],
    )
    conversation_store.append(helper.id, [_say("assistant", "zebra in helper")])

    for asked in (root_id, side_id):
        body = (
            await client.get(
                f"/v1/sessions/{asked}/items/search", params={"query": "zebra", "scope": "family"}
            )
        ).json()
        hits = {(hit["session_id"], hit["text"]) for hit in body["data"]}
        assert hits == {(root_id, "zebra in the root"), (side_id, "zebra in side")}
        for hit in body["data"]:
            assert hit["message_id"] == hit["item"]["id"]
            assert hit["role"] in ("user", "assistant")

    # The default scope is unchanged: this session's items only.
    own = (
        await client.get(f"/v1/sessions/{root_id}/items/search", params={"query": "zebra"})
    ).json()
    assert [item["id"] for item in own["data"]] and "session_id" not in own["data"][0]
