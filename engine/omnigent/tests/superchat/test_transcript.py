"""The transcript projection (omnigent.superchat.transcript): rules on item fixtures, then the
route's paging, seed cut and access over a real store."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fastapi import APIRouter, FastAPI

from omnigent.entities import (
    CompactionData,
    ErrorData,
    FunctionCallData,
    FunctionCallOutputData,
    MessageData,
    NewConversationItem,
)
from omnigent.errors import OmnigentError
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.transcript.blocks import project_items
from omnigent.superchat.transcript.routes import register_transcript_routes

_MODE = {"omnigent.context.mode": "superside-chat"}


def _msg(item_id: str, role: str, text: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": "message",
        "role": role,
        "created_at": 100,
        "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}],
        **extra,
    }


def _call(item_id: str, name: str, call_id: str, args: dict | None = None) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": "function_call",
        "name": name,
        "call_id": call_id,
        "arguments": json.dumps(args or {}),
        "created_at": 100,
    }


def _out(item_id: str, call_id: str, output: Any) -> dict[str, Any]:
    text = output if isinstance(output, str) else json.dumps(output)
    return {"id": item_id, "type": "function_call_output", "call_id": call_id, "output": text}


_CARD = {
    "type": "card",
    "card": "plan",
    "id": "plan-1",
    "data": {"steps": ["a"]},
    "fallback": " the plan ",
    "note": "internal",
}


def test_text_messages_keep_role_and_order() -> None:
    out = project_items([_msg("m1", "user", "hi"), _msg("m2", "assistant", "hello")])
    assert [(m["id"], m["role"], m["blocks"]) for m in out] == [
        ("m1", "user", [{"type": "text", "text": "hi"}]),
        ("m2", "assistant", [{"type": "text", "text": "hello"}]),
    ]
    assert out[0]["created_at"] == 100


def test_a_turn_shows_only_its_last_text_and_keeps_cards_and_chips() -> None:
    found = {
        "type": "file_search",
        "results": [{"file_id": "f" * 32, "file_name": "a.pdf", "page": 3}],
    }
    card = {"type": "card", "card": "note", "fallback": "Note", "data": {}}
    items = [
        _msg("u1", "user", "find the budget"),
        _msg("a1", "assistant", "Search found nothing, so I'll read the file."),
        _call("c1", "files_search", "k1"),
        _out("o1", "k1", found),
        _msg("a2", "assistant", "Four pages. Extract text with Python."),
        _call("c2", "render_card", "k2", card),
        _out("o2", "k2", card),
        _msg("a3", "assistant", "The budget is 4.7 million (a.pdf p. 3)."),
        _msg("u2", "user", "thanks"),
        _msg("a4", "assistant", "Anytime."),
        _msg("n1", "user", "[system notice]", is_system_notice=True),
        _msg("a5", "assistant", "A Helper finished."),
    ]
    out = project_items(items)
    assert [m["id"] for m in out] == ["u1", "c2", "a3", "u2", "a4", "a5"]
    assert out[1]["blocks"][0]["type"] == "card"
    assert [b["type"] for b in out[2]["blocks"]] == ["text", "card"]
    assert out[2]["blocks"][1]["card"]["card"] == "passages"


def test_system_notice_and_hidden_context_are_dropped() -> None:
    items = [
        _msg("n1", "user", "timer fired", is_system_notice=True),
        _msg("n2", "user", "[System: old notice]"),
        _msg("n3", "user", "skill text", is_meta=True),
        _msg("m1", "user", "real"),
    ]
    assert [m["id"] for m in project_items(items)] == ["m1"]


def test_card_call_becomes_a_card_message_without_internal_fields() -> None:
    items = [_call("c1", "mcp__omnigent__render_card", "k1"), _out("o1", "k1", _CARD)]
    (message,) = project_items(items)
    assert message["role"] == "assistant"
    (block,) = message["blocks"]
    assert block["type"] == "card" and block["card_id"] == "plan-1"
    assert block["card"] == {
        "card": "plan",
        "id": "plan-1",
        "data": {"steps": ["a"]},
        "fallback": "the plan",
    }
    assert "pending" not in block


def test_card_without_output_is_pending_and_failed_card_is_skipped() -> None:
    args = {"card": "plan", "fallback": "wait", "data": {"x": 1}}
    (pending,) = project_items([_call("c1", "render_card", "k1", args)])
    assert pending["blocks"][0]["pending"] is True
    assert pending["blocks"][0]["card"]["data"] == {}
    failed = [_call("c2", "render_card", "k2", args), _out("o2", "k2", {"error": "bad card"})]
    assert project_items(failed) == []


def test_repeated_call_id_is_one_block() -> None:
    items = [
        _call("c1", "render_card", "k1"),
        _call("c1b", "render_card", "k1"),
        _out("o1", "k1", _CARD),
    ]
    assert len(project_items(items)) == 1


def test_helper_row_follows_the_hand_off_message() -> None:
    receipt = {"started": True, "helper_id": "conv_h1", "title": "Research", "message": "x"}
    items = [
        _call("h1", "start_helper", "kh"),
        _out("ho", "kh", receipt),
        _call("h1b", "start_helper", "kh"),  # repeated call: still one row
        _msg("m1", "assistant", "On it."),
    ]
    (message,) = project_items(items, helper_statuses={"conv_h1": "in_progress"})
    assert message["blocks"] == [
        {"type": "text", "text": "On it."},
        {
            "type": "helper",
            "call_id": "kh",
            "session_id": "conv_h1",
            "title": "Research",
            "status": "in_progress",
        },
    ]


def test_refused_helper_call_shows_nothing() -> None:
    items = [
        _call("h1", "start_helper", "kh"),
        _out("ho", "kh", "Error: start_helper: no"),
        _msg("m1", "assistant", "Sorry."),
    ]
    (message,) = project_items(items)
    assert message["blocks"] == [{"type": "text", "text": "Sorry."}]


def test_deck_export_becomes_a_file_block() -> None:
    saved = {"type": "artifact", "id": "art_2", "name": "q3.pptx", "kind": "pptx", "size": 5}
    items = [_call("d1", "deck_export", "kd"), _out("do", "kd", saved)]
    [message] = project_items(items)
    assert message["blocks"][0]["type"] == "file"
    assert message["blocks"][0]["artifact_id"] == "art_2"
    assert (
        project_items([_call("d2", "deck_export", "ke"), _out("eo", "ke", {"error": "x"})]) == []
    )


def test_display_chart_becomes_a_file_block() -> None:
    saved = {
        "type": "artifact", "id": "art_9", "name": "rev.chart.json", "kind": "json", "size": 90,
        "title": "Revenue", "chart": {"chart_type": "bar"},
    }  # fmt: skip
    [message] = project_items([_call("c1", "display_chart", "kc"), _out("co", "kc", saved)])
    block = message["blocks"][0]
    assert block["type"] == "file" and block["artifact_id"] == "art_9"
    assert block["name"] == "rev.chart.json" and block["title"] == "Revenue"
    assert (
        project_items([_call("c2", "display_chart", "kf"), _out("cf", "kf", {"error": "x"})]) == []
    )


def test_delivered_artifact_is_a_user_file_block_and_other_resources_show_nothing() -> None:
    saved = {"type": "artifact", "id": "art_3", "name": "q3.pdf", "kind": "pdf", "size": 7}
    event = {
        "id": "r1",
        "type": "resource_event",
        "event_type": "session.resource.created",
        "resource_id": "art_3",
        "resource_type": "artifact",
        "resource": saved,
        "created_at": 100,
    }
    [message] = project_items([event])
    assert message["blocks"] == [
        {"type": "file", "artifact_id": "art_3", "name": "q3.pdf", "mime": KIND_MIME["pdf"],
         "kind": "pdf", "size": 7, "by": "user"}
    ]  # fmt: skip
    upload = {**event, "id": "r2", "resource_type": "file", "resource_id": "file_1"}
    assert project_items([upload, {**event, "id": "r3", "event_type": "x"}]) == []


def test_artifact_save_becomes_a_file_block_and_secret_request_a_secure_entry() -> None:
    saved = {"type": "artifact", "id": "art_1", "name": "r.pdf", "kind": "pdf", "size": 9}
    request = {"secure_entry": {"id": "req_1", "name": "Login", "site": "example.com"}}
    items = [
        _call("a1", "artifact_save", "ka"),
        _out("ao", "ka", saved),
        _call("v1", "vault_request_secret", "kv"),
        _out("vo", "kv", request),
        _call("a2", "artifact_save", "kb"),
        _out("bo", "kb", {"error": "nope"}),
    ]
    file_msg, secure_msg = project_items(items)
    assert file_msg["blocks"] == [
        {
            "type": "file",
            "artifact_id": "art_1",
            "name": "r.pdf",
            "mime": "application/pdf",
            "kind": "pdf",
            "size": 9,
        }
    ]
    assert secure_msg["blocks"] == [
        {"type": "secure_entry", "request_id": "req_1", "name": "Login", "site": "example.com"}
    ]


@pytest.mark.parametrize(
    ("stored", "public"),
    [
        ("RuntimeError", "internal"),
        ("ConnectionClosedException", "internal"),
        ("model_unavailable", "internal"),
        ("rate_limit_exceeded", "rate_limited"),
        ("connection_error", "provider_unavailable"),
        ("server_error", "provider_unavailable"),
        ("context_length_exceeded", "context_too_long"),
        ("budget_exhausted", "insufficient_credit"),
        ("managed_sandbox_workspace_reset", "workspace_reset"),
        ("timeout", "timeout"),
        ("insufficient_credit", "insufficient_credit"),
    ],
)
def test_legacy_error_codes_read_as_the_closed_set(stored: str, public: str) -> None:
    (message,) = project_items([{"id": "e1", "type": "error", "code": stored, "message": "x"}])
    assert message["blocks"] == [{"type": "error", "code": public}]


def test_error_item_carries_a_code_and_no_text() -> None:
    item = {"id": "e1", "type": "error", "code": "rate_limited", "message": "Too many requests"}
    (message,) = project_items([item])
    assert message["blocks"] == [{"type": "error", "code": "rate_limited"}]
    assert "Too many" not in json.dumps(message)


# ── route: paging, seed, access ──────────────────────────────────────────


def _new(kind: str, data: Any, response_id: str = "r1") -> NewConversationItem:
    return NewConversationItem(type=kind, response_id=response_id, data=data)


def _say(role: str, text: str) -> NewConversationItem:
    content = [{"type": "input_text" if role == "user" else "output_text", "text": text}]
    return _new(
        "message",
        MessageData(role=role, content=content, agent="brain" if role == "assistant" else None),
    )


@pytest.fixture()
async def client(conversation_store: SqlAlchemyConversationStore) -> httpx.AsyncClient:
    app = FastAPI()
    router = APIRouter()
    register_transcript_routes(router, conversation_store=conversation_store)
    app.include_router(router, prefix="/v1")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
        yield http


async def test_pages_walk_back_with_before_and_unknown_session_is_not_found(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    conversation_store.append(root.id, [_say("user", f"m{i}") for i in range(5)])
    first = (await client.get(f"/v1/sessions/{root.id}/transcript?limit=2")).json()
    assert [m["blocks"][0]["text"] for m in first["data"]] == ["m3", "m4"]
    assert first["has_more"] is True and first["lineage"]["kind"] == "super"
    second = (
        await client.get(
            f"/v1/sessions/{root.id}/transcript?limit=2&before={first['older_cursor']}"
        )
    ).json()
    assert [m["blocks"][0]["text"] for m in second["data"]] == ["m1", "m2"]
    last = (
        await client.get(
            f"/v1/sessions/{root.id}/transcript?limit=2&before={second['older_cursor']}"
        )
    ).json()
    assert [m["blocks"][0]["text"] for m in last["data"]] == ["m0"]
    assert last["has_more"] is False and last["older_cursor"] is None
    with pytest.raises(OmnigentError, match="not found"):
        await client.get("/v1/sessions/ad563e906854634c49e1a6fd2fbb31d4/transcript")


async def test_side_chat_seed_is_left_out_unless_asked(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    side = conversation_store.create_conversation(
        kind="default",
        title="Side",
        labels={
            **_MODE,
            SIDE_CHAT_LABEL_KEY: "true",
            "omnigent.side_chat.parent_id": root.id,
            "omnigent.side_chat.start": "with_context",
        },
    )
    seed = _new(
        "compaction",
        CompactionData(summary="s", last_item_id="x", model="m", token_count=1),
        response_id=f"rollover_seed_{side.id}",
    )
    conversation_store.append(
        side.id, [_say("user", "copied"), seed, _say("user", "mine"), _say("assistant", "reply")]
    )
    url = f"/v1/sessions/{side.id}/transcript"
    own = (await client.get(url)).json()
    assert [m["blocks"][0]["text"] for m in own["data"]] == ["mine", "reply"]
    assert own["lineage"] == {
        "kind": "side",
        "root_id": root.id,
        "parent_id": root.id,
        "seed_item_id": own["lineage"]["seed_item_id"],
        "anchor_item_id": None,
    }
    assert own["lineage"]["seed_item_id"]
    everything = (await client.get(url, params={"include_seed": "true"})).json()
    assert [m["blocks"][0]["text"] for m in everything["data"]] == [
        "copied",
        "mine",
        "reply",
    ]


async def test_store_items_project_end_to_end_with_error_code_and_helper_status(
    client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    helper = conversation_store.create_conversation(
        kind="sub_agent", parent_conversation_id=root.id, title="Job", labels=_MODE
    )
    conversation_store.set_session_live_status(helper.id, "running")
    receipt = json.dumps({"started": True, "helper_id": helper.id, "title": "Job"})
    conversation_store.append(
        root.id,
        [
            _say("user", "do it"),
            _new(
                "function_call",
                FunctionCallData(agent="brain", name="start_helper", arguments="{}", call_id="kh"),
            ),
            _new("function_call_output", FunctionCallOutputData(call_id="kh", output=receipt)),
            _say("assistant", "Started."),
            _new(
                "error",
                ErrorData(source="llm", code="RuntimeError", message="Raw English failure"),
            ),
        ],
    )
    body = (await client.get(f"/v1/sessions/{root.id}/transcript")).json()
    assistant, error = body["data"][1], body["data"][2]
    assert assistant["blocks"][1]["status"] == "in_progress"
    assert assistant["blocks"][1]["session_id"] == helper.id
    assert error["blocks"] == [{"type": "error", "code": "internal"}]
    helper_view = (await client.get(f"/v1/sessions/{helper.id}/transcript")).json()
    assert helper_view["lineage"]["kind"] == "helper"
    assert helper_view["lineage"]["root_id"] == root.id


# ── reset, live flag, redaction ──────────────────────────────────────────


@pytest.fixture()
async def reset_client(conversation_store: SqlAlchemyConversationStore) -> httpx.AsyncClient:
    from omnigent.superchat.transcript.reset import register_reset_routes

    app = FastAPI()
    router = APIRouter()
    register_transcript_routes(router, conversation_store=conversation_store)
    register_reset_routes(router, conversation_store=conversation_store)
    app.include_router(router, prefix="/v1")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as http:
        yield http


def _texts(body: dict[str, Any]) -> list[str]:
    return [m["blocks"][0]["text"] for m in body["data"]]


async def test_reset_starts_the_transcript_after_it_and_pages_the_history_on_request(
    reset_client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    from omnigent.context.rollover import RESET_HEADER, split_at_latest_compaction

    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    conversation_store.append(root.id, [_say("user", "old q"), _say("assistant", "old a")])
    url = f"/v1/sessions/{root.id}/transcript"
    assert (await reset_client.get(url)).json()["reset"] is None

    reset = (await reset_client.post(f"/v1/sessions/{root.id}/reset")).json()
    assert reset["reset_item_id"] and reset["session_id"] == root.id
    # Idempotent while nothing happened since.
    again = (await reset_client.post(f"/v1/sessions/{root.id}/reset")).json()
    assert again["reset_item_id"] == reset["reset_item_id"]
    conversation_store.append(root.id, [_say("user", "new q"), _say("assistant", "new a")])

    body = (await reset_client.get(url)).json()
    assert _texts(body) == ["new q", "new a"]
    assert body["has_more"] is False and body["older_cursor"] is None
    assert body["reset"] == {"item_id": reset["reset_item_id"], "created_at": reset["created_at"]}
    assert (await reset_client.get(url, params={"limit": 1})).json()["has_more"] is True

    history = (await reset_client.get(url, params={"before_reset": "true"})).json()
    assert _texts(history) == ["old q", "old a"]

    # The model's context after the reset: the reset framing, then only the new turns.
    items = [i.to_api_dict() for i in conversation_store.list_items(root.id, limit=50).data]
    after, checkpoint = split_at_latest_compaction(items)
    assert checkpoint is not None and checkpoint["summary"] == RESET_HEADER
    assert [i["content"][0]["text"] for i in after] == ["new q", "new a"]
    assert checkpoint["compacted_messages"][0]["content"][0]["text"] == RESET_HEADER


async def test_reset_is_refused_mid_turn_and_outside_a_super_chat(
    reset_client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    conversation_store.append(root.id, [_say("user", "q")])
    conversation_store.set_session_live_status(root.id, "running")
    with pytest.raises(OmnigentError, match="turn is running"):
        await reset_client.post(f"/v1/sessions/{root.id}/reset")
    side = conversation_store.create_conversation(
        kind="default",
        title="Side",
        labels={**_MODE, SIDE_CHAT_LABEL_KEY: "true", "omnigent.side_chat.parent_id": root.id},
    )
    plain = conversation_store.create_conversation(kind="default", title="P")
    for other in (side, plain):
        with pytest.raises(OmnigentError, match="Only a Super Chat"):
            await reset_client.post(f"/v1/sessions/{other.id}/reset")


async def test_before_reset_is_empty_without_a_reset_and_live_follows_the_turn(
    reset_client: httpx.AsyncClient, conversation_store: SqlAlchemyConversationStore
) -> None:
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    conversation_store.append(root.id, [_say("user", "q")])
    url = f"/v1/sessions/{root.id}/transcript"
    empty = (await reset_client.get(url, params={"before_reset": "true"})).json()
    assert empty["data"] == [] and empty["has_more"] is False
    assert (await reset_client.get(url)).json()["live"] is False
    conversation_store.set_session_live_status(root.id, "running")
    assert (await reset_client.get(url)).json()["live"] is True


async def test_transcript_redacts_deployment_secrets(
    reset_client: httpx.AsyncClient,
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "sk-test-0123456789abcdef"
    monkeypatch.setenv("ACME_API_KEY", secret)
    root = conversation_store.create_conversation(kind="default", title="S", labels=_MODE)
    card = {**_CARD, "fallback": f"key {secret}", "data": {"k": secret}}
    conversation_store.append(
        root.id,
        [
            _say("assistant", f"your key is {secret}"),
            _new(
                "function_call",
                FunctionCallData(agent="brain", name="render_card", arguments="{}", call_id="k"),
            ),
            _new(
                "function_call_output",
                FunctionCallOutputData(call_id="k", output=json.dumps(card)),
            ),
        ],
    )
    raw = (await reset_client.get(f"/v1/sessions/{root.id}/transcript")).text
    assert secret not in raw and "[redacted]" in raw
