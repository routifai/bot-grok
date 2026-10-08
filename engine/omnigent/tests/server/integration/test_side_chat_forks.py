"""Forks (ADR 0010): a Side Chat started from one message, driven through the real app.

The seed's summarizer is stubbed (it records what it was asked to summarise); everything else
is the real fork, side-chat, transcript, related-chats, reset and add-back routes.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import pytest

from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE
from omnigent.entities import CompactionData, MessageData, NewConversationItem
from omnigent.stores.conversation_store import (
    SIDE_CHAT_LABEL_KEY,
    SIDE_CHAT_PARENT_LABEL_KEY,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.family.signals import listen_chats_changed, listen_message_done
from omnigent.superchat.side_chats.forks import (
    FORK_ADDED_RESPONSE_PREFIX,
    FORK_ANCHOR_LABEL_KEY,
    FORK_PARENT_LABEL_KEY,
    FORK_SUMMARY_LABEL_KEY,
    added_summary_text,
)
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemyConversationStore:
    return SqlAlchemyConversationStore(db_uri)


@pytest.fixture()
def summarized(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Stub the seed summarizer; each call's input text is recorded."""
    from omnigent.context import rollover as rollover_module

    calls: list[str] = []

    async def fake_summarize_history(messages: list[dict[str, Any]], *args: Any, **kwargs: Any):
        del args, kwargs
        calls.append(str(messages))
        return {"text": "SUMMARY", "token_count": 3}

    monkeypatch.setattr(rollover_module, "summarize_history", fake_summarize_history)
    return calls


def _say(role: str, text: str, response_id: str, *, meta: bool = False) -> NewConversationItem:
    content = [{"type": "input_text" if role == "user" else "output_text", "text": text}]
    return NewConversationItem(
        type="message",
        response_id=response_id,
        data=MessageData(
            role=role,
            content=content,
            agent="brain" if role == "assistant" else None,
            is_meta=meta,
        ),
    )


async def _super_chat(client: httpx.AsyncClient, name: str) -> str:
    agent = await create_test_agent(client, name=name)
    resp = await client.post(
        "/v1/sessions",
        json={"agent_id": agent["id"], "labels": {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _conversation(store: SqlAlchemyConversationStore, root_id: str) -> dict[str, str]:
    """Three turns in the root, a minute old (a fork's copies keep these times); ids by text."""
    from omnigent.stores.conversation_store import sqlalchemy_store

    with pytest.MonkeyPatch.context() as patch:
        earlier = int(time.time()) - 60
        patch.setattr(sqlalchemy_store, "now_epoch", lambda: earlier)
        items = _append_turns(store, root_id)
    return {item.data.content[0]["text"]: item.id for item in items}  # type: ignore[union-attr]


def _append_turns(store: SqlAlchemyConversationStore, root_id: str) -> list[Any]:
    return store.append(
        root_id,
        [
            _say("user", "q1", "r1"),
            _say("assistant", "a1", "r1"),
            _say("user", "q2", "r2"),
            _say("assistant", "a2", "r2"),
            _say("user", "q3", "r3"),
            _say("assistant", "a3", "r3"),
        ],
    )


async def _fork(client: httpx.AsyncClient, chat_id: str, anchor: str, **extra: Any) -> str:
    resp = await client.post(
        f"/v1/sessions/{chat_id}/side_chats",
        json={"start": "with_context", "anchor_item_id": anchor, **extra},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["anchor_item_id"] == anchor and body["parent_id"] == chat_id
    return body["conversation_id"]


def _seed(store: SqlAlchemyConversationStore, chat_id: str) -> CompactionData:
    seeds = [
        item.data
        for item in store.list_items(chat_id, limit=500, type="compaction").data
        if item.response_id == f"rollover_seed_{chat_id}"
    ]
    assert len(seeds) == 1
    assert isinstance(seeds[0], CompactionData)
    return seeds[0]


def _texts(messages: list[dict[str, Any]] | None) -> list[str]:
    return [m.get("content", [{}])[0].get("text", "") for m in messages or []]


def _shown(messages: list[dict[str, Any]]) -> list[str]:
    """The text blocks of transcript messages."""
    return [b["text"] for m in messages for b in m["blocks"] if b["type"] == "text"]


async def _error_code(resp: httpx.Response) -> str:
    return resp.json()["error"]["code"]


# ── create ──────────────────────────────────────────────────────────────


async def test_fork_seed_ends_at_the_anchor(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-seed")
    ids = _conversation(store, root_id)

    fork_id = await _fork(client, root_id, ids["a2"], title="About a2")
    fork = store.get_conversation(fork_id)
    assert fork is not None and fork.title == "About a2"
    assert fork.labels[SIDE_CHAT_LABEL_KEY]
    assert fork.labels[SIDE_CHAT_PARENT_LABEL_KEY] == root_id
    assert fork.labels[FORK_ANCHOR_LABEL_KEY] == ids["a2"]
    assert fork.labels[FORK_PARENT_LABEL_KEY] == root_id

    seed = _seed(store, fork_id)
    assert seed.last_item_id == ids["a2"]
    kept = _texts(seed.compacted_messages)
    assert "a2" in kept and "q3" not in kept and "a3" not in kept
    assert "q3" not in summarized[-1] and "a2" in summarized[-1]
    # The copy stops at the anchor's turn too: nothing later reaches the fork.
    copied = [item.to_api_dict() for item in store.list_items(fork_id, limit=50).data]
    assert "q3" not in str(copied)

    # A user message is a valid anchor too: the seed keeps it (no mid-turn trim).
    user_fork = await _fork(client, root_id, ids["q2"])
    assert _seed(store, user_fork).last_item_id == ids["q2"]

    # Without a title the fork gets the existing derived title (renamed later by auto-title).
    assert store.get_conversation(user_fork).title  # type: ignore[union-attr]


async def test_invalid_anchors_are_refused(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-invalid")
    ids = _conversation(store, root_id)
    other_root = await _super_chat(client, "forks-invalid-other")
    other_ids = _conversation(store, other_root)
    [hidden, notice] = store.append(
        root_id,
        [
            _say("user", "skill text", "r4", meta=True),
            NewConversationItem(
                type="message",
                response_id="r5",
                data=MessageData(
                    role="user",
                    is_system_notice=True,
                    content=[{"type": "input_text", "text": "timer fired"}],
                ),
            ),
        ],
    )
    helper = store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=root_id,
        title="job",
        labels={CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE},
    )
    [helper_msg] = store.append(helper.id, [_say("assistant", "helper said", "h1")])

    for anchor in (other_ids["a1"], hidden.id, notice.id, helper_msg.id, "not-an-id"):
        resp = await client.post(
            f"/v1/sessions/{root_id}/side_chats",
            json={"start": "with_context", "anchor_item_id": anchor},
        )
        assert resp.status_code == 422, (anchor, resp.text)
        assert await _error_code(resp) == "fork_anchor_invalid"

    # A Helper cannot open a fork, even of its own message.
    resp = await client.post(
        f"/v1/sessions/{helper.id}/side_chats",
        json={"start": "with_context", "anchor_item_id": helper_msg.id},
    )
    assert resp.status_code == 403, resp.text

    # A fork starts with context.
    resp = await client.post(
        f"/v1/sessions/{root_id}/side_chats",
        json={"start": "blank", "anchor_item_id": ids["a1"]},
    )
    assert resp.status_code == 400, resp.text


async def test_fork_of_a_fork_is_allowed_once(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-nested")
    ids = _conversation(store, root_id)
    fork_id = await _fork(client, root_id, ids["a2"])
    own = {
        item.data.content[0]["text"]: item.id  # type: ignore[union-attr]
        for item in store.append(
            fork_id,
            [
                _say("user", "zebra question", "f1"),
                _say("assistant", "zebra answer", "f1"),
                _say("user", "later in fork", "f2"),
            ],
        )
    }

    added = await client.post(
        f"/v1/sessions/{fork_id}/add_to_conversation", json={"summary": "Zebras are fine"}
    )
    assert added.status_code == 200, added.text

    nested_id = await _fork(client, fork_id, own["zebra answer"])
    nested = store.get_conversation(nested_id)
    assert nested is not None
    assert FORK_SUMMARY_LABEL_KEY not in nested.labels  # not its parent's added state
    assert nested.labels[SIDE_CHAT_PARENT_LABEL_KEY] == root_id  # still the family's root
    assert nested.labels[FORK_PARENT_LABEL_KEY] == fork_id
    seed = _seed(store, nested_id)
    assert seed.last_item_id == own["zebra answer"]
    # Built on the fork's own seed (its summary) plus the fork's turns up to the anchor.
    assert "SUMMARY" in summarized[-1] and "zebra answer" in summarized[-1]
    assert "later in fork" not in summarized[-1] and "q3" not in summarized[-1]

    lineage = (await client.get(f"/v1/sessions/{nested_id}/transcript")).json()["lineage"]
    assert lineage["root_id"] == root_id and lineage["parent_id"] == fork_id
    assert lineage["anchor_item_id"] == own["zebra answer"]

    # The fork's copied context is not one of its own messages.
    copied_id = store.list_items(fork_id, limit=1).data[0].id
    resp = await client.post(
        f"/v1/sessions/{fork_id}/side_chats",
        json={"start": "with_context", "anchor_item_id": copied_id},
    )
    assert resp.status_code == 422 and await _error_code(resp) == "fork_anchor_invalid"

    # No third level.
    [deep] = store.append(nested_id, [_say("assistant", "nested reply", "n1")])
    resp = await client.post(
        f"/v1/sessions/{nested_id}/side_chats",
        json={"start": "with_context", "anchor_item_id": deep.id},
    )
    assert resp.status_code == 422 and await _error_code(resp) == "fork_too_deep"

    # The family sees every fork: related chats, counts, anchors, and search.
    rows = {
        row["id"]: row
        for row in (await client.get(f"/v1/sessions/{root_id}/related_chats")).json()["data"]
    }
    assert rows[fork_id]["fork_count"] == 1 and rows[fork_id]["anchor_item_id"] == ids["a2"]
    assert rows[nested_id]["fork_count"] == 0
    assert rows[nested_id]["anchor_item_id"] == own["zebra answer"]
    from_fork = {
        row["id"]: row
        for row in (await client.get(f"/v1/sessions/{fork_id}/related_chats")).json()["data"]
    }
    assert from_fork[root_id]["fork_count"] == 1  # the root's own forks: just this one
    hits = (
        await client.get(
            f"/v1/sessions/{root_id}/items/search", params={"query": "zebra", "scope": "family"}
        )
    ).json()["data"]
    assert {hit["session_id"] for hit in hits} == {fork_id}


async def test_an_anchorless_side_chat_still_cannot_open_a_side_chat_or_a_fork(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-anchorless")
    ids = _conversation(store, root_id)
    resp = await client.post(f"/v1/sessions/{root_id}/side_chats", json={"start": "with_context"})
    assert resp.status_code == 201, resp.text
    side_id = resp.json()["conversation_id"]
    assert resp.json()["anchor_item_id"] is None and resp.json()["parent_id"] is None
    side = store.get_conversation(side_id)
    assert side is not None and FORK_ANCHOR_LABEL_KEY not in side.labels
    assert FORK_PARENT_LABEL_KEY not in side.labels
    # Unchanged seed rule: everything up to the last reply.
    assert _seed(store, side_id).last_item_id == ids["a3"]

    [own] = store.append(side_id, [_say("assistant", "side reply", "s1")])
    for body in (
        {"start": "blank"},
        {"start": "with_context", "anchor_item_id": own.id},
    ):
        resp = await client.post(f"/v1/sessions/{side_id}/side_chats", json=body)
        assert resp.status_code == 403, resp.text
        assert "Side Chat" in resp.json()["error"]["message"]

    transcript = (await client.get(f"/v1/sessions/{side_id}/transcript")).json()
    assert transcript["lineage"]["anchor_item_id"] is None
    assert transcript["lineage"]["parent_id"] == root_id
    assert [m["forks"] for m in transcript["data"]] == [[]]
    row = next(
        r
        for r in (await client.get(f"/v1/sessions/{root_id}/related_chats")).json()["data"]
        if r["id"] == side_id
    )
    assert row["anchor_item_id"] is None and row["fork_count"] == 0


# ── transcript ──────────────────────────────────────────────────────────


async def test_transcript_lists_forks_under_their_anchor(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-transcript")
    ids = _conversation(store, root_id)
    busy = await _fork(client, root_id, ids["a2"], title="Busy")
    archived = await _fork(client, root_id, ids["a2"], title="Old")
    early = await _fork(client, root_id, ids["q1"], title="Early")
    store.append(busy, [_say("user", "why?", "b1"), _say("assistant", "because", "b1")])
    store.update_conversation(archived, archived=True)
    store.set_session_live_status(early, "running")

    data = (await client.get(f"/v1/sessions/{root_id}/transcript")).json()["data"]
    by_id = {m["id"]: m for m in data}
    under_a2 = by_id[ids["a2"]]["forks"]
    rows = {row["session_id"]: row for row in under_a2}  # same second: either order
    assert set(rows) == {busy, archived}
    busy_row, archived_row = rows[busy], rows[archived]
    assert busy_row["title"] == "Busy" and busy_row["replies"] == 2
    assert busy_row["state"] == "open" and busy_row["unread"] is True
    assert busy_row["live"] is False and busy_row["summary"] is None
    assert archived_row["state"] == "archived" and archived_row["replies"] == 0
    assert archived_row["unread"] is False
    [early_row] = by_id[ids["q1"]]["forks"]
    assert early_row["session_id"] == early and early_row["live"] is True
    for text in ("a1", "q2", "q3", "a3"):
        assert by_id[ids[text]]["forks"] == []

    # A fork lists the forks of its own messages.
    [mine] = store.append(busy, [_say("assistant", "more", "b2")])
    nested = await _fork(client, busy, mine.id)
    fork_view = (await client.get(f"/v1/sessions/{busy}/transcript")).json()["data"]
    assert [row["session_id"] for row in fork_view[-1]["forks"]] == [nested]


async def test_a_reset_hides_earlier_forks_until_the_history_is_paged(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-reset")
    ids = _conversation(store, root_id)
    fork_id = await _fork(client, root_id, ids["a1"])
    assert (await client.post(f"/v1/sessions/{root_id}/reset")).status_code == 200
    store.append(root_id, [_say("user", "fresh", "r9")])

    url = f"/v1/sessions/{root_id}/transcript"
    current = (await client.get(url)).json()["data"]
    assert [m["forks"] for m in current] == [[]]
    history = (await client.get(url, params={"before_reset": "true"})).json()["data"]
    by_id = {m["id"]: m for m in history}
    assert [row["session_id"] for row in by_id[ids["a1"]]["forks"]] == [fork_id]


# ── add to Conversation ─────────────────────────────────────────────────


async def test_add_to_conversation_tells_the_muse_and_shows_under_the_anchor(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-add")
    ids = _conversation(store, root_id)
    fork_id = await _fork(client, root_id, ids["a2"], title="Margins")
    store.append(fork_id, [_say("user", "why?", "f1"), _say("assistant", "Costs.", "f1")])

    chats: asyncio.Queue[dict] = asyncio.Queue()
    messages: asyncio.Queue[dict] = asyncio.Queue()
    stop_chats = listen_chats_changed(root_id, chats)
    stop_messages = listen_message_done(root_id, messages)
    try:
        resp = await client.post(
            f"/v1/sessions/{fork_id}/add_to_conversation", json={"summary": "Margins fell"}
        )
        assert resp.status_code == 200, resp.text
        added = resp.json()
        assert added == {
            "fork_id": fork_id,
            "session_id": root_id,
            "anchor_item_id": ids["a2"],
            "item_id": added["item_id"],
            "title": "Margins",
            "summary": "Margins fell",
            "state": "added",
        }
        assert (await asyncio.wait_for(chats.get(), 1)) == {
            "type": "chats.changed",
            "root_id": root_id,
        }
        assert (await asyncio.wait_for(messages.get(), 1))["item_id"] == added["item_id"]

        # The Muse reads it: a system notice in the Conversation, pointing back to the fork.
        notice = store.get_item(root_id, added["item_id"])
        assert notice is not None and isinstance(notice.data, MessageData)
        assert notice.response_id == f"{FORK_ADDED_RESPONSE_PREFIX}{fork_id}"
        assert notice.data.is_system_notice and not notice.data.is_meta
        assert notice.data.content[0]["text"] == added_summary_text("Margins", "Margins fell")

        # The transcript draws it under the anchor, not as a message of its own.
        data = (await client.get(f"/v1/sessions/{root_id}/transcript")).json()["data"]
        assert added["item_id"] not in {m["id"] for m in data}
        anchor = next(m for m in data if m["id"] == ids["a2"])
        assert anchor["blocks"][-1] == {
            "type": "fork_summary",
            "fork_id": fork_id,
            "anchor_item_id": ids["a2"],
            "title": "Margins",
            "summary": "Margins fell",
        }
        assert anchor["forks"][0]["state"] == "added"
        assert anchor["forks"][0]["summary"] == "Margins fell"

        # Idempotent: the same summary adds nothing; a new one replaces it.
        again = (
            await client.post(
                f"/v1/sessions/{fork_id}/add_to_conversation", json={"summary": "Margins fell"}
            )
        ).json()
        assert again["item_id"] == added["item_id"]
        assert messages.empty()
        newer = (
            await client.post(
                f"/v1/sessions/{fork_id}/add_to_conversation", json={"summary": "Costs rose"}
            )
        ).json()
        assert newer["item_id"] != added["item_id"]
        data = (await client.get(f"/v1/sessions/{root_id}/transcript")).json()["data"]
        anchor = next(m for m in data if m["id"] == ids["a2"])
        assert [b["summary"] for b in anchor["blocks"] if b["type"] == "fork_summary"] == [
            "Costs rose"
        ]
    finally:
        stop_chats()
        stop_messages()

    # Archiving keeps the summary but the fork's state follows the archive.
    store.update_conversation(fork_id, archived=True)
    data = (await client.get(f"/v1/sessions/{root_id}/transcript")).json()["data"]
    row = next(m for m in data if m["id"] == ids["a2"])["forks"][0]
    assert row["state"] == "archived" and row["summary"] == "Costs rose"


async def test_add_to_conversation_writes_a_summary_when_none_is_given(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-add-generated")
    ids = _conversation(store, root_id)
    fork_id = await _fork(client, root_id, ids["a1"])

    empty = await client.post(f"/v1/sessions/{fork_id}/add_to_conversation")
    assert empty.status_code == 400, empty.text  # nothing of its own to add yet

    store.append(
        fork_id,
        [
            _say("user", "is it worth it?", "f1"),
            _say("assistant", "Yes, the plan pays back within a year. Details follow.", "f1"),
        ],
    )
    # No runner answers in this app, so the reply's first sentence is the summary.
    resp = await client.post(f"/v1/sessions/{fork_id}/add_to_conversation", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["summary"] == "Yes, the plan pays back within a year."

    not_fork = await client.post(f"/v1/sessions/{root_id}/add_to_conversation")
    assert not_fork.status_code == 422 and await _error_code(not_fork) == "not_a_fork"


# ── related_chats rows ──────────────────────────────────────────────────


def _set_workspace(store: SqlAlchemyConversationStore, chat_id: str, workspace: str) -> None:
    from omnigent.db.db_models import SqlConversationMetadata, current_workspace_id

    with store._session("test_set_workspace") as session:
        meta = session.get(SqlConversationMetadata, (current_workspace_id(), chat_id))
        assert meta is not None
        meta.workspace = workspace


async def test_related_chats_rows_carry_the_fork_fields(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    from omnigent.superchat.lineage import PROJECT_NAME_LABEL_KEY

    root_id = await _super_chat(client, "forks-rows")
    ids = _conversation(store, root_id)
    resp = await client.post(f"/v1/sessions/{root_id}/side_chats", json={"start": "blank"})
    assert resp.status_code == 201, resp.text
    plain_id = resp.json()["conversation_id"]

    open_id = await _fork(client, root_id, ids["a1"], title="Open")
    added_id = await _fork(client, root_id, ids["a2"], title="Added")
    archived_id = await _fork(client, root_id, ids["q3"], title="Archived")
    store.append(open_id, [_say("user", "why?", "o1"), _say("assistant", "because", "o1")])
    _, own = store.append(
        added_id,
        [
            _say("user", "margins?", "a1x"),
            _say("assistant", "  Costs\n   fell,  prices   too.  " + "x" * 200, "a1x"),
        ],
    )
    resp = await client.post(
        f"/v1/sessions/{added_id}/add_to_conversation", json={"summary": "Margins fell"}
    )
    assert resp.status_code == 200, resp.text
    store.update_conversation(archived_id, archived=True)
    nested_id = await _fork(client, added_id, own.id)
    store.append(nested_id, [_say("user", "and then?", "n1")])
    store.set_labels(open_id, {PROJECT_NAME_LABEL_KEY: "Q3 board deck"})
    _set_workspace(store, open_id, "/home/u/workspace/projects/q3-deck")

    data = (await client.get(f"/v1/sessions/{root_id}/related_chats")).json()["data"]
    rows = {row["id"]: row for row in data}
    fork_keys = ("fork_state", "fork_summary", "fork_parent_id", "anchor_snippet", "replies")

    plain = rows[plain_id]
    assert [plain[key] for key in fork_keys] == [None] * 5 and plain["project"] is None

    opened = rows[open_id]
    assert opened["fork_state"] == "open" and opened["fork_summary"] is None
    assert opened["fork_parent_id"] == root_id and opened["anchor_snippet"] == "a1"
    assert opened["replies"] == 2
    assert opened["project"] == {"slug": "q3-deck", "name": "Q3 board deck"}

    added = rows[added_id]
    assert added["fork_state"] == "added" and added["fork_summary"] == "Margins fell"
    assert added["fork_parent_id"] == root_id and added["anchor_snippet"] == "a2"
    assert added["replies"] == 2 and added["project"] is None

    archived = rows[archived_id]
    assert archived["fork_state"] == "archived" and archived["fork_summary"] is None
    assert archived["anchor_snippet"] == "q3" and archived["replies"] == 0

    nested = rows[nested_id]
    assert nested["fork_state"] == "open" and nested["fork_parent_id"] == added_id
    assert len(nested["anchor_snippet"]) == 120 and nested["anchor_snippet"].endswith("…")
    assert nested["anchor_snippet"].startswith("Costs fell, prices too. xxx")
    assert nested["replies"] == 1

    # The same numbers as the transcript's forks[].
    transcript = (await client.get(f"/v1/sessions/{root_id}/transcript")).json()["data"]
    forks = {row["session_id"]: row for m in transcript for row in m["forks"]}
    for fork_id in (open_id, added_id, archived_id):
        assert forks[fork_id]["replies"] == rows[fork_id]["replies"]
        assert forks[fork_id]["state"] == rows[fork_id]["fork_state"]
        assert forks[fork_id]["summary"] == rows[fork_id]["fork_summary"]


# ── a fork's copy ends at its anchor ────────────────────────────────────


def _late_items() -> list[NewConversationItem]:
    """What comes after the anchor in the same turn, and after it (no response id)."""
    from omnigent.entities import ErrorData, FunctionCallData, FunctionCallOutputData

    return [
        NewConversationItem(
            type="function_call",
            response_id="r2",
            data=FunctionCallData(
                agent="brain", name="artifact_save", arguments="{}", call_id="c1"
            ),
        ),
        NewConversationItem(
            type="function_call_output",
            response_id="r2",
            data=FunctionCallOutputData(call_id="c1", output="saved"),
        ),
        _say("assistant", "late reply", "r2"),
        NewConversationItem(
            type="error",
            response_id="err1",
            data=ErrorData(source="harness", code="sandbox_unavailable", message="restarted"),
        ),
        NewConversationItem(
            type="message",
            response_id="notice",
            data=MessageData(
                role="user",
                is_system_notice=True,
                content=[{"type": "input_text", "text": "[System: later notice]"}],
            ),
        ),
        _say("user", "q9", "r9"),
        _say("assistant", "a9", "r9"),
    ]


async def test_a_fork_copies_nothing_after_its_anchor(
    client: httpx.AsyncClient, store: SqlAlchemyConversationStore, summarized: list[str]
) -> None:
    root_id = await _super_chat(client, "forks-cut")
    ids = _conversation(store, root_id)
    # Same turn (response r2) as the anchor "a2", then errors, notices and later turns.
    store.append(root_id, _late_items())
    fork_id = await _fork(client, root_id, ids["a2"])
    fork = store.get_conversation(fork_id)
    assert fork is not None

    texts = [
        text
        for item in store.list_items(fork_id, limit=500).data
        if isinstance(item.data, MessageData)
        for text in [item.data.content[0].get("text", "")]
    ]
    assert "a2" in texts
    for late in ("late reply", "[System: later notice]", "q9", "a9", "q3", "a3"):
        assert late not in texts
    types = [item.type for item in store.list_items(fork_id, limit=500).data]
    assert "function_call" not in types and "error" not in types
    # The Muse's seed is written from the record cut at the anchor, too.
    assert "late reply" not in summarized[-1] and "q9" not in summarized[-1]

    store.append(fork_id, [_say("user", "mine", "m1"), _say("assistant", "my reply", "m1")])
    shown = (await client.get(f"/v1/sessions/{fork_id}/transcript")).json()["data"]
    assert _shown(shown) == ["mine", "my reply"]
    full = (await client.get(f"/v1/sessions/{fork_id}/transcript?include_seed=true")).json()[
        "data"
    ]
    assert "a2" in _shown(full) and "late reply" not in _shown(full)


async def test_a_fork_without_a_seed_still_hides_its_copied_context(
    client: httpx.AsyncClient,
    store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from omnigent.context import rollover as rollover_module

    async def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("no model")

    monkeypatch.setattr(rollover_module, "summarize_history", broken)
    root_id = await _super_chat(client, "forks-noseed")
    ids = _conversation(store, root_id)
    store.append(root_id, _late_items())
    fork_id = await _fork(client, root_id, ids["a2"])
    fork = store.get_conversation(fork_id)
    assert fork is not None
    assert not [
        i
        for i in store.list_items(fork_id, limit=500, type="compaction").data
        if i.response_id == f"rollover_seed_{fork_id}"
    ]
    store.append(fork_id, [_say("user", "mine", "m1"), _say("assistant", "my reply", "m1")])
    shown = (await client.get(f"/v1/sessions/{fork_id}/transcript")).json()["data"]
    assert _shown(shown) == ["mine", "my reply"]
