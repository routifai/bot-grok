"""Tasks (ADR 0025): the engine keeps a deliverable's state from what happened."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.context.labels import SCHEDULED_HELPER_LABEL_KEY
from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.tasks import runtime
from omnigent.superchat.tasks.record import (
    MAX_LINES,
    CardAnswer,
    Task,
    best_match,
    kind_for_name,
    parse_card_answer,
    prefix_lines,
    task_line,
)
from omnigent.superchat.tasks.routes import create_tasks_router
from omnigent.superchat.tasks.service import TaskService
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

# ---------------------------------------------------------------- the record (pure)


def _task(title: str = "RBC vs TD", kind: str = "deck", status: str = "open", **fields: Any):
    return Task("t1", "o", "c", kind, title, dict(fields), status)


def test_a_task_reads_as_one_line_with_what_comes_next() -> None:
    task = _task(look="Pitch Deck", data="mock")
    assert (
        task_line(task)
        == 'Open task: deck "RBC vs TD" · look Pitch Deck · data: mock · next: build'
    )
    building = _task(status="building", look="Nord", slides=6)
    assert task_line(building).endswith("· look Nord · 6 slides · next: check and save")
    helped = _task(answered="Real data")
    helped.helper_ids.append("h1")
    assert task_line(helped).endswith("· answered: Real data · next: wait for the helper")


def test_the_pick_comes_first_and_the_lines_are_capped() -> None:
    tasks = [_task(f"Deck {n}") for n in range(8)] + [_task("Old", status="done")]
    lines = prefix_lines(tasks, CardAnswer("c1", "pitch-deck", "Pitch Deck"))
    assert lines[0] == "They picked Pitch Deck. Continue the task; do not plan it again."
    assert len(lines) == MAX_LINES and all("Old" not in line for line in lines)
    assert prefix_lines([], None) == []


def test_a_card_answer_is_read_only_in_its_shape() -> None:
    answer = {"card_id": "c1", "option_id": "nord", "label": "  Nord  "}
    assert parse_card_answer({"card_answer": answer}) == CardAnswer("c1", "nord", "Nord")
    assert parse_card_answer({"card_answer": {**answer, "label": ""}}) is None
    assert parse_card_answer({"card_answer": {"card_id": "c1", "label": "x"}}) is None
    assert parse_card_answer({"open_artifact": {}}) is None
    assert parse_card_answer(None) is None


def test_a_saved_file_matches_its_task_by_kind_and_title() -> None:
    assert [kind_for_name(n) for n in ("a.deck.html", "a.html", "a.md", "a.csv", "a.png")] == [
        "deck",
        "page",
        "document",
        "sheet",
        "file",
    ]
    deck, memo = _task("RBC vs TD"), _task("Provisions memo", kind="document")
    assert best_match([deck, memo], "deck", "RBC vs. TD comparison", "x.deck.html") is deck
    assert best_match([deck, memo], "deck", "", "rbc-vs-td.deck.html") is deck
    assert best_match([deck, memo], "deck", "Quarterly hiring plan", "hiring.deck.html") is None
    assert best_match([_task(status="done")], "deck", "RBC vs TD") is None


# ---------------------------------------------------------------- the service and routes


class _LocalAuth:
    def get_user_id(self, request: Request) -> str | None:
        return None


def _say(conversations: SqlAlchemyConversationStore, chat: str, text: str) -> str:
    (item,) = conversations.append(
        chat,
        [
            NewConversationItem(
                type="message",
                response_id="resp_1",
                data=MessageData(role="user", content=[{"type": "input_text", "text": text}]),
            )
        ],
    )
    return item.id


@pytest.fixture()
def env(db_uri: str):
    conversations = SqlAlchemyConversationStore(db_uri)
    service = TaskService(SqlAlchemyTaskStore(db_uri), conversations)
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code}}, status_code=exc.http_status)

    app.include_router(create_tasks_router(service, auth_provider=_LocalAuth()), prefix="/v1")
    chat = conversations.create_conversation().id
    return TestClient(app), service, conversations, chat


def _event(client: TestClient, session: str, **body: Any) -> dict[str, Any] | None:
    resp = client.post(f"/v1/sessions/{session}/tasks/events", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["task"]


def test_a_deck_is_building_once_written_and_done_once_saved(env) -> None:
    client, _service, conversations, chat = env
    _say(conversations, chat, "Create some presentation about RBC vs TD")
    deck = {"title": "RBC vs TD", "look": "Pitch Deck", "look_id": "pitch-deck-vc"}
    menu = _event(client, chat, event="deck_new", **deck, look_from="chosen", written=False)
    assert menu["status"] == "open" and menu["fields"]["look"] == "Pitch Deck"
    built = _event(
        client, chat, event="deck_new", **deck, slides=6, file="rbc-vs-td.deck.html", written=True
    )
    assert built["id"] == menu["id"] and built["status"] == "building"
    view = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert [t["id"] for t in view["tasks"]] == [built["id"]]
    assert view["message"] == "Create some presentation about RBC vs TD" and view["answer"] is None
    saved = _event(
        client,
        chat,
        event="artifact_save",
        name="rbc-vs-td.deck.html",
        title="RBC vs TD",
        group_id="g1",
    )
    assert saved["id"] == built["id"] and saved["status"] == "done"
    assert saved["artifact_group_ids"] == ["g1"]
    assert client.get(f"/v1/sessions/{chat}/tasks").json()["tasks"] == []
    # a later save of the same file stays on that task
    again = _event(client, chat, event="artifact_save", name="renamed.deck.html", group_id="g1")
    assert again["id"] == built["id"]


def test_a_save_with_no_task_is_recorded_done(env) -> None:
    client, service, _conversations, chat = env
    saved = _event(
        client, chat, event="artifact_save", name="memo.md", title="Memo", group_id="g2"
    )
    assert (saved["kind"], saved["status"], saved["fields"]) == (
        "document",
        "done",
        {"file": "memo.md"},
    )
    assert service.store.list(chat)[0].id == saved["id"]


def test_a_helpers_events_land_on_the_conversation_that_started_it(env) -> None:
    client, service, conversations, chat = env
    _say(conversations, chat, "a deck about our 2026 sales")
    _event(client, chat, event="deck_new", title="Sales 2026", look="Nord", look_id="nord")
    helper = conversations.create_conversation(kind="sub_agent", parent_conversation_id=chat).id
    started = _event(client, chat, event="start_helper", helper_id=helper)
    assert started["helper_ids"] == [helper]
    view = client.get(f"/v1/sessions/{helper}/tasks").json()
    assert view["conversation_id"] == chat and view["is_helper"] is True
    assert view["message"] == "a deck about our 2026 sales" and view["background"] is False
    done = _event(
        client, helper, event="artifact_save", name="sales-2026.deck.html", group_id="g3"
    )
    assert done["id"] == started["id"] and done["status"] == "done"
    assert service.store.list(helper) == []
    scheduled = conversations.create_conversation(
        kind="sub_agent", parent_conversation_id=chat, labels={SCHEDULED_HELPER_LABEL_KEY: "t1"}
    ).id
    assert client.get(f"/v1/sessions/{scheduled}/tasks").json()["background"] is True


def test_a_start_with_no_active_task_and_an_unknown_event_change_nothing(env) -> None:
    client, service, _conversations, chat = env
    assert _event(client, chat, event="start_helper", helper_id="h1") is None
    assert client.post(f"/v1/sessions/{chat}/tasks/events", json={"event": "x"}).status_code == 400
    assert client.get(f"/v1/sessions/{'f' * 32}/tasks").status_code == 404
    assert service.store.list(chat) == []


def test_a_card_answer_is_recorded_and_read_by_the_next_turn(env) -> None:
    from omnigent.server.routes._sessions import orchestration

    client, service, conversations, chat = env
    _say(conversations, chat, "a deck about RBC vs TD")
    task = _event(client, chat, event="deck_new", title="RBC vs TD", look="Corporate Clean")
    answer = {"card_id": "c1", "option_id": "pitch-deck", "label": "Pitch Deck VC"}
    hooks = {"tasks": service.card_answered}
    body = SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": "Pitch Deck VC"}]},
        context={"card_answer": answer},
    )
    conv = conversations.get_conversation(chat)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(orchestration, "ON_MESSAGE_CONTEXT", hooks)
        item = asyncio.run(orchestration._persist_user_event_item(chat, conv, body, conversations))
    view = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert view["answer"] == answer
    fields = view["tasks"][0]["fields"]
    assert view["tasks"][0]["id"] == task["id"]
    assert (fields["look"], fields["look_id"], fields["look_from"]) == (
        "Pitch Deck",
        "pitch-deck-vc",
        "picked",
    )
    assert fields["answers"] == [{**answer, "item_id": item.id}]
    # one message later the pick is history: on the task, not announced again
    _say(conversations, chat, "and make it short")
    later = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert later["answer"] is None and later["tasks"][0]["fields"]["look_id"] == "pitch-deck-vc"
    # an answer that picks no theme is the task's answered field
    service.card_answered(
        chat,
        _say(conversations, chat, "Mock"),
        {"card_answer": {**answer, "option_id": "mock", "label": "Mock"}},
    )
    assert service.store.list(chat)[0].fields["answered"] == "Mock"


def test_deleting_the_conversation_drops_its_tasks(env) -> None:
    client, service, _conversations, chat = env
    _event(client, chat, event="artifact_save", name="memo.md", group_id="g2")
    service.conversation_deleted(chat)
    assert service.store.list(chat) == []


# ---------------------------------------------------------------- the runner side


def _view(
    tasks: list[dict[str, Any]],
    answer: dict[str, str] | None = None,
    *,
    at: str = "conv1",
    **extra,
):
    return {
        "conversation_id": at,
        "is_helper": False,
        "tasks": tasks,
        "answer": answer,
    } | extra


def _server(view: dict[str, Any] | None, posted: list[dict[str, Any]] | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and posted is not None:
            posted.append(json.loads(request.content))
            return httpx.Response(200, json={"task": None})
        if view is not None and request.url.path.endswith("/tasks"):
            return httpx.Response(200, json=view)
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")


_OPEN = {
    "id": "t1",
    "kind": "deck",
    "title": "RBC vs TD",
    "status": "open",
    "fields": {"look": "Pitch Deck"},
}


async def test_the_turn_gets_the_pick_then_one_line_per_task() -> None:
    answer = {"card_id": "c1", "option_id": "pitch-deck", "label": "Pitch Deck"}
    blocks = await runtime.message_prefix(_server(_view([_OPEN], answer)), "conv1", ["Pitch Deck"])
    assert blocks == [
        "They picked Pitch Deck. Continue the task; do not plan it again.\n"
        'Open task: deck "RBC vs TD" · look Pitch Deck · next: build'
    ]
    assert await runtime.message_prefix(_server(_view([])), "conv1", ["hi"]) == []
    # a Helper works from its Brief; no server, no block
    helper = _view([_OPEN], is_helper=True, conversation_id="root")
    assert await runtime.message_prefix(_server(helper), "conv1", ["go"]) == []
    assert await runtime.message_prefix(_server(None), "conv1", ["hi"]) == []
    assert await runtime.message_prefix(None, "conv1", ["hi"]) == []
    runtime.turn_ended("conv1")


async def test_tool_results_reach_the_server_in_order() -> None:
    posted: list[dict[str, Any]] = []
    client = _server(None, posted)

    def ran(tool: str, output: dict[str, Any] | str) -> None:
        text = output if isinstance(output, str) else json.dumps(output)
        runtime.on_result(HandlerCtx(tool, client, "conv2"), text)

    ran("deck_new", {"ok": True, "written": True, "deck": {"title": "T", "look": "Nord"}})
    ran("start_helper", {"started": True, "helper_id": "h1"})
    ran("start_helper", "Error: start_helper: no")
    ran("artifact_save", {"type": "artifact", "name": "t.deck.html", "id": "a1", "group_id": "g1"})
    ran("artifact_save", {"error": "nope"})
    ran("memory_search", {"results": []})
    await runtime.flush("conv2")
    assert posted == [
        {"event": "deck_new", "title": "T", "look": "Nord", "written": True},
        {"event": "start_helper", "helper_id": "h1"},
        {"event": "artifact_save", "name": "t.deck.html", "title": None, "group_id": "g1"},
    ]


async def test_a_turn_on_a_task_that_ends_without_acting_is_a_stall(monkeypatch) -> None:
    logged: list[tuple[str, dict[str, Any]]] = []

    class _Log:
        def info(self, message: str, *args: Any, **kwargs: Any) -> None:
            logged.append((message % args, kwargs.get("extra") or {}))

    monkeypatch.setattr(runtime, "_logger", _Log())
    monkeypatch.setattr(runtime, "_watching", {})
    monkeypatch.setattr(runtime, "STALLS", runtime._Stalls())
    session = "conv-stall-test"
    opened = _view([_OPEN], at=session)
    await runtime.message_prefix(_server(opened), session, ["Pitch Deck"])
    runtime.turn_ended(session)
    assert runtime.STALLS.count == 1
    assert logged == [(f"stall for {session} on task t1", {"session_id": session})]
    for tool, output in (
        ("artifact_save", {"type": "artifact", "name": "a.md", "group_id": "g"}),
        ("ask_clarification", {"type": "card", "card": "ask"}),
        ("start_helper", {"started": True, "helper_id": "h"}),
    ):
        await runtime.message_prefix(_server(opened), session, ["go"])
        runtime.on_result(HandlerCtx(tool, None, session), json.dumps(output))
        runtime.turn_ended(session)
    assert runtime.STALLS.count == 1
    # a failed tool is not an ending; no task at turn start is never a stall
    await runtime.message_prefix(_server(opened), session, ["go"])
    runtime.on_result(HandlerCtx("start_helper", None, session), "Error: start_helper: no")
    runtime.turn_ended(session)
    await runtime.message_prefix(_server(_view([], at=session)), session, ["hi"])
    runtime.turn_ended(session)
    assert runtime.STALLS.count == 2


def test_a_task_left_behind_for_a_day_is_dropped(env, monkeypatch) -> None:
    from omnigent.superchat.tasks import service as service_module

    client, service, _conversations, chat = env
    _event(client, chat, event="deck_new", title="Old deck", look="Nord")
    later = service_module.now_epoch() + service_module.STALE_AFTER + 1
    monkeypatch.setattr(service_module, "now_epoch", lambda: later)
    assert client.get(f"/v1/sessions/{chat}/tasks").json()["tasks"] == []
    assert service.store.list(chat)[0].status == "dropped"
