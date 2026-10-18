"""Tasks (ADR 0025): the engine keeps a deliverable's state from what happened."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.context.labels import SCHEDULED_HELPER_LABEL_KEY
from omnigent.entities import (
    FunctionCallData,
    FunctionCallOutputData,
    MessageData,
    NewConversationItem,
)
from omnigent.errors import OmnigentError
from omnigent.runner.app import _evaluate_policy_via_omnigent
from omnigent.runner.proxy_mcp_manager import ProxyMcpManager
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.cards.handlers import handle_clarification_tool
from omnigent.superchat.cards.tools import build_clarification
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.step_limit.policy import REFUSAL as STEP_LIMIT_REFUSAL
from omnigent.superchat.tasks import runtime
from omnigent.superchat.tasks.record import (
    MAX_LINES,
    STALE_AFTER,
    CardAnswer,
    Task,
    Turn,
    best_match,
    ends_well,
    is_stall,
    kind_for_brief,
    kind_for_name,
    parse_card_answer,
    prefix_lines,
    task_line,
    watched,
)
from omnigent.superchat.tasks.routes import create_tasks_router
from omnigent.superchat.tasks.service import TaskService
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore
from omnigent.superchat.transcript.blocks import project_items

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
    helped.helper_running = True
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


def test_a_helpers_brief_names_its_kind() -> None:
    assert [
        kind_for_brief(b)
        for b in (
            "Build a 6-slide deck on RBC vs TD",
            "Pricing spreadsheet of four vendors",
            "A landing page for the launch",
            "Write a report on the EU AI Act",
            "Research RBC and TD figures",
        )
    ] == ["deck", "sheet", "page", "document", "file"]


@pytest.mark.parametrize(
    ("turn", "well"),
    [
        (Turn(by_person=True, task_id="t"), False),
        (Turn(by_person=True, task_id="t", saved=True), True),
        (Turn(by_person=True, task_id="t", asked=True), True),
        (Turn(by_person=True, task_id="t", helper_started=True), True),
        (Turn(by_person=True), True),
        (Turn(by_person=False, task_id="t"), True),  # a notice or a Helper's wake
        (Turn(by_person=True, task_id="t", helper_running=True), True),  # a steer
        (Turn(by_person=True, refused=True), False),
        (Turn(by_person=True, task_id="t", refused=True, saved=True), False),
        (Turn(by_person=True, refused=True, helper_started=True), True),
    ],
)
def test_the_one_stall_rule(turn: Turn, well: bool) -> None:
    assert ends_well(turn) is well and is_stall(turn) is not well


def test_only_a_persons_turn_on_an_open_task_is_watched() -> None:
    assert watched(Turn(by_person=True, task_id="t"))
    assert not watched(Turn(by_person=True))
    assert not watched(Turn(by_person=False, task_id="t"))
    assert not watched(Turn(by_person=True, task_id="t", helper_running=True))


# ---------------------------------------------------------------- the service and routes


class _LocalAuth:
    def get_user_id(self, request: Request) -> str | None:
        return None


def _append(conversations: SqlAlchemyConversationStore, chat: str, item_type: str, data):
    (item,) = conversations.append(
        chat, [NewConversationItem(type=item_type, response_id="resp_1", data=data)]
    )
    return item.id


def _say(conversations: SqlAlchemyConversationStore, chat: str, text: str, **flags: Any) -> str:
    data = MessageData(role="user", content=[{"type": "input_text", "text": text}], **flags)
    return _append(conversations, chat, "message", data)


def _ask(
    conversations: SqlAlchemyConversationStore,
    chat: str,
    task_id: str | None,
    *,
    by: str = "card",
    n: int = 1,
) -> str:
    """An ``ask_clarification`` call and its card result, as the handler stores them; the card
    id the web sends back: the engine's own (*by* ``card``, the transcript's ``card_id``) or an
    older client's ``<call item id>:<block>`` (*by* ``item``)."""
    call_id = f"call_{n}"
    call = _append(
        conversations,
        chat,
        "function_call",
        FunctionCallData(agent="a", name="ask_clarification", arguments="{}", call_id=call_id),
    )
    card = build_clarification(
        {"question": "Which look?", "options": ["Nord", "Bauhaus"]}, task_id, f"ask-{n}"
    )
    _append(
        conversations,
        chat,
        "function_call_output",
        FunctionCallOutputData(call_id=call_id, output=json.dumps(card)),
    )
    (message,) = project_items(
        [i.to_api_dict() for i in conversations.list_items(chat, limit=100).data][-2:]
    )
    assert message["blocks"][0]["card_id"] == f"ask-{n}"  # what the web sends back
    return f"ask-{n}" if by == "card" else f"{call}:0"


@pytest.fixture()
def env(db_uri: str):
    return make_env(db_uri)


def make_env(db_uri: str):
    """A task service behind its routes, and a Conversation: ``(client, service, store, id)``."""
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


def _view(client: TestClient, session: str) -> dict[str, Any]:
    return client.get(f"/v1/sessions/{session}/tasks").json()


def test_a_deck_builds_in_its_turn_and_is_done_when_the_saving_turn_ends(env) -> None:
    client, _service, conversations, chat = env
    _say(conversations, chat, "Create some presentation about RBC vs TD")
    deck = {"title": "RBC vs TD", "look": "Pitch Deck", "look_id": "pitch-deck-vc"}
    menu = _event(client, chat, event="deck_new", **deck, look_from="chosen", written=False)
    assert menu["status"] == "building" and menu["fields"]["look"] == "Pitch Deck"
    built = _event(
        client, chat, event="deck_new", **deck, slides=6, file="rbc-vs-td.deck.html", written=True
    )
    assert built["id"] == menu["id"] and built["status"] == "building"
    view = _view(client, chat)
    assert [t["id"] for t in view["tasks"]] == [built["id"]]
    assert view["message"] == "Create some presentation about RBC vs TD" and view["answer"] is None
    assert view["by_person"] is True
    saved = _event(
        client,
        chat,
        event="artifact_save",
        name="rbc-vs-td.deck.html",
        title="RBC vs TD",
        group_id="g1",
    )
    # a save does not close the task; the turn that saved it does
    assert saved["id"] == built["id"] and saved["status"] == "building"
    assert saved["artifact_group_ids"] == ["g1"]
    # the turn's end answers with the task it closed, and its decision line
    closed = _event(client, chat, event="turn_end")
    assert closed["id"] == built["id"] and closed["status"] == "done"
    assert (
        closed["fields"]["decision"] == "RBC vs TD (deck): look Pitch Deck, 6 slides, not checked"
    )
    assert _view(client, chat)["tasks"] == []
    # a later save of the same file stays on that task
    again = _event(client, chat, event="artifact_save", name="renamed.deck.html", group_id="g1")
    assert again["id"] == built["id"] and again["status"] == "done"


def test_a_turn_that_ends_without_saving_leaves_its_task_open(env) -> None:
    client, service, _conversations, chat = env
    task = _event(client, chat, event="deck_new", title="Q3", written=False)
    assert task["status"] == "building"
    _event(client, chat, event="turn_end")
    assert service.store.list(chat)[0].status == "open"


def test_a_conversations_first_save_with_no_open_task_opens_one(env) -> None:
    client, service, _conversations, chat = env
    saved = _event(
        client, chat, event="artifact_save", name="memo.md", title="Memo", group_id="g2"
    )
    assert (saved["kind"], saved["status"], saved["fields"]["file"]) == (
        "document",
        "building",
        "memo.md",
    )
    _event(client, chat, event="turn_end")
    assert service.store.list(chat)[0].status == "done"
    assert "saved_this_turn" not in service.store.list(chat)[0].fields


def _helper(conversations: SqlAlchemyConversationStore, chat: str, **labels: str) -> str:
    """A running Helper of *chat*."""
    helper = conversations.create_conversation(
        kind="sub_agent", parent_conversation_id=chat, labels=labels
    ).id
    conversations.set_session_live_status(helper, "running")
    return helper


def test_a_helper_works_on_its_task_its_saves_are_drafts_and_its_finish_closes_it(env) -> None:
    client, service, conversations, chat = env
    _say(conversations, chat, "a deck about our 2026 sales")
    deck = _event(client, chat, event="deck_new", title="Sales 2026", look="Nord", look_id="nord")
    helper = _helper(conversations, chat)
    # started in the same turn that created the task: it attaches to it
    started = _event(client, chat, event="start_helper", helper_id=helper, title="Research")
    assert started["id"] == deck["id"] and started["helper_ids"] == [helper]
    assert started["helper_running"] is True
    view = _view(client, helper)
    assert view["conversation_id"] == chat and view["is_helper"] is True
    assert view["message"] == "a deck about our 2026 sales" and view["background"] is False
    assert view["by_person"] is False
    draft = _event(client, helper, event="artifact_save", name="draft.deck.html", group_id="g3")
    assert draft["id"] == deck["id"] and draft["status"] == "building"
    assert draft["artifact_group_ids"] == ["g3"]
    assert service.store.list(helper) == []
    # the Conversation's turn ends while the Helper runs: still building
    _event(client, chat, event="turn_end")
    running = _view(client, chat)["tasks"][0]
    assert (running["status"], running["helper_running"]) == ("building", True)
    # the Helper finishes; the turn its completion notice opens reads the task done
    conversations.set_session_live_status(helper, "idle")
    _say(
        conversations, chat, "[System: sub-agent worker/Research finished]", is_system_notice=True
    )
    view = _view(client, chat)
    assert view["tasks"] == [] and view["by_person"] is False
    # a read never closes it: the turn's start does
    assert service.store.list(chat)[0].status == "building"
    _event(client, chat, event="turn_start")
    assert service.store.list(chat)[0].status == "done"
    scheduled = _helper(conversations, chat, **{SCHEDULED_HELPER_LABEL_KEY: "t1"})
    assert _view(client, scheduled)["background"] is True


def test_a_failed_helper_reopens_its_task(env) -> None:
    client, service, conversations, chat = env
    helper = _helper(conversations, chat)
    started = _event(client, chat, event="start_helper", helper_id=helper, title="Sales deck")
    assert (started["kind"], started["title"]) == ("deck", "Sales deck")
    conversations.set_session_live_status(helper, "failed")
    assert _view(client, chat)["tasks"][0]["status"] == "open"
    assert service.store.list(chat)[0].status == "building"
    _event(client, chat, event="turn_start")
    assert service.store.list(chat)[0].status == "open"


def test_a_helper_with_no_task_opens_one_of_its_briefs_kind(env) -> None:
    client, service, conversations, chat = env
    deck = _event(client, chat, event="deck_new", title="Board deck")
    report = _event(
        client,
        chat,
        event="start_helper",
        helper_id=_helper(conversations, chat),
        title="Write a report on the EU AI Act",
    )
    assert report["kind"] == "document" and report["title"] == "Write a report on the EU AI Act"
    research = _event(
        client,
        chat,
        event="start_helper",
        helper_id=_helper(conversations, chat),
        title="Research figures",
    )
    # no kind named: the newest active task, never a new one
    assert research["id"] in (deck["id"], report["id"])
    assert len(service.store.list(chat)) == 2


def test_an_unknown_event_or_session_changes_nothing(env) -> None:
    client, service, _conversations, chat = env
    assert client.post(f"/v1/sessions/{chat}/tasks/events", json={"event": "x"}).status_code == 400
    assert client.get(f"/v1/sessions/{'f' * 32}/tasks").status_code == 404
    assert _event(client, chat, event="start_helper", helper_id="") is None
    assert service.store.list(chat) == []


def _answer_message(conversations, chat: str, service: TaskService, answer: dict[str, str]):
    from omnigent.server.routes._sessions import orchestration

    body = SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": answer["label"]}]},
        context={"card_answer": answer},
    )
    conv = conversations.get_conversation(chat)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(orchestration, "ON_MESSAGE_CONTEXT", {"tasks": service.message_context})
        return asyncio.run(orchestration._persist_user_event_item(chat, conv, body, conversations))


@pytest.mark.parametrize("by", ["card", "item"])
def test_a_card_answer_is_kept_on_the_message_and_on_the_task_its_card_asked_for(
    env, by: str
) -> None:
    client, service, conversations, chat = env
    _say(conversations, chat, "a deck about RBC vs TD")
    asked = _event(client, chat, event="deck_new", title="RBC vs TD", look="Corporate Clean")
    other = _event(client, chat, event="artifact_save", name="memo.md", group_id="g9")
    # a later card about the other task: the answer names its own card, not the newest
    card_id = _ask(conversations, chat, asked["id"], by=by)
    _ask(conversations, chat, other["id"], n=2)
    answer = {"card_id": card_id, "option_id": "nord"}
    item = _answer_message(conversations, chat, service, {**answer, "label": "Nord"})
    view = _view(client, chat)
    assert view["answer"] == {**answer, "label": "Nord"}
    by_id = {t["id"]: t for t in view["tasks"]}
    assert by_id[asked["id"]]["fields"]["answers"] == [
        {**answer, "label": "Nord", "item_id": item.id}
    ]
    assert by_id[asked["id"]]["fields"]["answered"] == "Nord"
    assert "answers" not in by_id[other["id"]]["fields"]
    # the answer lives with the message: a new service (a restart) still reads it
    fresh = TaskService(service.store, conversations)
    assert fresh.view(chat)["answer"] == {**answer, "label": "Nord"}
    # one message later the pick is history: on the task, not announced again
    _say(conversations, chat, "and make it short")
    assert _view(client, chat)["answer"] is None


def test_a_card_answer_whose_card_names_no_task_touches_none(env) -> None:
    client, service, conversations, chat = env
    _event(client, chat, event="deck_new", title="RBC vs TD")
    for card_id in (_ask(conversations, chat, None), "not-a-card:0", "c1"):
        answer = {"card_id": card_id, "option_id": "x", "label": "X"}
        _answer_message(conversations, chat, service, answer)
        assert _view(client, chat)["answer"] == answer
    assert "answers" not in service.store.list(chat)[0].fields


def test_deleting_the_conversation_drops_its_tasks_and_answers(env) -> None:
    client, service, conversations, chat = env
    _event(client, chat, event="artifact_save", name="memo.md", group_id="g2")
    item = _answer_message(
        conversations, chat, service, {"card_id": "c", "option_id": "o", "label": "L"}
    )
    service.conversation_deleted(chat)
    assert service.store.list(chat) == [] and service.store.answer(chat, item.id) is None


def test_a_task_left_behind_for_a_day_is_skipped_on_read_and_dropped_on_the_next_event(
    env, monkeypatch
) -> None:
    from omnigent.superchat.tasks import service as service_module

    client, service, conversations, chat = env
    _event(client, chat, event="deck_new", title="Old deck", look="Nord")
    later = service_module.now_epoch() + STALE_AFTER + 1
    monkeypatch.setattr(service_module, "now_epoch", lambda: later)
    assert _view(client, chat)["tasks"] == []
    assert service.store.list(chat)[0].status == "building"
    _event(client, chat, event="start_helper", helper_id=_helper(conversations, chat), title="x")
    assert [t.status for t in service.store.list(chat)] == ["building", "dropped"]


def test_a_late_deck_event_finds_the_saved_task_by_its_file(env) -> None:
    """A ``deck_new`` event that lands after the save closed the task (a slow or retried POST)
    updates the done task: no second task, not back to building."""
    client, service, conversations, chat = env
    _say(conversations, chat, "a deck about RBC vs TD")
    deck = {"title": "RBC vs TD", "look": "Swiss Grid", "look_id": "swiss-grid"}
    saved = _event(
        client, chat, event="artifact_save", name="rbc.deck.html", title="RBC", group_id="g1"
    )
    _event(client, chat, event="turn_end")
    late = _event(
        client, chat, event="deck_new", **deck, file="rbc.deck.html", slides=6, written=True
    )
    assert late["id"] == saved["id"] and late["status"] == "done"
    assert late["fields"]["look_id"] == "swiss-grid" and late["fields"]["slides"] == 6
    assert len(service.store.list(chat)) == 1


# ---------------------------------------------------------------- the runner side


def _wire(
    tasks: list[dict[str, Any]],
    answer: dict[str, str] | None = None,
    *,
    at: str = "conv1",
    by_person: bool = True,
):
    return {"conversation_id": at, "tasks": tasks, "answer": answer, "by_person": by_person}


def _server(view: dict[str, Any] | None, posted: list[dict[str, Any]] | None = None, task=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and posted is not None:
            posted.append(json.loads(request.content))
            return httpx.Response(200, json={"task": task})
        if view is not None and request.url.path.endswith("/tasks"):
            return httpx.Response(200, json=view)
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")


async def _sent(session: str) -> None:
    """Wait for *session*'s queued event posts."""
    seen = None
    while (pending := runtime._posts.get(session)) is not None and pending is not seen:
        seen = pending
        await pending


_OPEN = {
    "id": "t1",
    "kind": "deck",
    "title": "RBC vs TD",
    "status": "open",
    "fields": {"look": "Pitch Deck"},
}


@pytest.fixture(autouse=True)
def _fresh_runtime(monkeypatch) -> None:
    monkeypatch.setattr(runtime, "_turns", {})
    monkeypatch.setattr(runtime, "_watching", {})
    monkeypatch.setattr(runtime, "_posts", {})
    monkeypatch.setattr(runtime, "_unsent", {})
    monkeypatch.setattr(runtime, "STALLS", 0)


async def test_the_turn_gets_the_pick_then_one_line_per_task() -> None:
    answer = {"card_id": "c1", "option_id": "pitch-deck", "label": "Pitch Deck"}
    blocks = await runtime.message_prefix(_server(_wire([_OPEN], answer)), "conv1", ["Pitch Deck"])
    assert blocks == [
        "They picked Pitch Deck. Continue the task; do not plan it again.\n"
        'Open task: deck "RBC vs TD" · look Pitch Deck · next: build'
    ]
    assert await runtime.message_prefix(_server(_wire([])), "conv1", ["hi"]) == []
    # a view of another conversation (a Helper's root) is not this turn's
    assert await runtime.message_prefix(_server(_wire([_OPEN], at="root")), "conv1", ["go"]) == []
    assert await runtime.message_prefix(_server(None), "conv1", ["hi"]) == []
    assert await runtime.message_prefix(None, "conv1", ["hi"]) == []


async def test_tool_results_and_the_turns_end_reach_the_server_in_order() -> None:
    posted: list[dict[str, Any]] = []
    client = _server(_wire([], at="conv2"), posted)
    await runtime.message_prefix(client, "conv2", ["make a deck"])

    def ran(tool: str, output: dict[str, Any] | str) -> None:
        text = output if isinstance(output, str) else json.dumps(output)
        runtime.on_result(HandlerCtx(tool, client, "conv2"), text)

    ran("deck_new", {"ok": True, "written": True, "deck": {"title": "T", "look": "Nord"}})
    ran("start_helper", {"started": True, "helper_id": "h1", "title": "Research"})
    ran("start_helper", "Error: start_helper: no")
    ran("artifact_save", {"type": "artifact", "name": "t.deck.html", "id": "a1", "group_id": "g1"})
    ran("artifact_save", {"error": "nope"})
    ran("memory_search", {"results": []})
    runtime.turn_ended("conv2")
    await _sent("conv2")
    assert posted == [
        {"event": "deck_new", "title": "T", "look": "Nord", "written": True},
        {"event": "start_helper", "helper_id": "h1", "title": "Research"},
        {
            "event": "artifact_save",
            "name": "t.deck.html",
            "title": None,
            "group_id": "g1",
            "artifact_id": "a1",
        },
        {"event": "turn_end"},
    ]
    # a turn with no task and no task event tells the server nothing at its end
    posted.clear()
    await runtime.message_prefix(client, "conv2", ["hi"])
    runtime.turn_ended("conv2")
    await _sent("conv2")
    assert posted == []


async def test_a_card_names_the_task_the_turn_works_on() -> None:
    args = {"question": "Which data?", "options": ["Mock", "Real"]}
    ctx = HandlerCtx("ask_clarification", None, "conv7")
    first = json.loads(await handle_clarification_tool(ctx, args))
    assert "task_id" not in first and first["id"].startswith("ask-")  # the engine's card id
    assert json.loads(await handle_clarification_tool(ctx, args))["id"] != first["id"]
    await runtime.message_prefix(_server(_wire([_OPEN], at="conv7")), "conv7", ["go"])
    assert json.loads(await handle_clarification_tool(ctx, args))["task_id"] == "t1"
    # a task the turn's own event created becomes the turn's task
    made = {**_OPEN, "id": "t2", "status": "building"}
    client = _server(_wire([], at="conv7"), [], task=made)
    await runtime.message_prefix(client, "conv7", ["a deck"])
    runtime.on_result(
        HandlerCtx("deck_new", client, "conv7"), json.dumps({"deck": {"title": "T"}})
    )
    await _sent("conv7")
    assert json.loads(await handle_clarification_tool(ctx, args))["task_id"] == "t2"


async def test_only_a_persons_turn_on_an_open_task_can_stall(monkeypatch) -> None:
    logged: list[tuple[str, dict[str, Any]]] = []

    class _Log:
        def info(self, message: str, *args: Any, **kwargs: Any) -> None:
            logged.append((message % args, kwargs.get("extra") or {}))

    monkeypatch.setattr(runtime, "_logger", _Log())
    session = "conv-stall-test"
    opened = _wire([_OPEN], at=session)
    await runtime.message_prefix(_server(opened), session, ["Pitch Deck"])
    runtime.turn_ended(session)
    assert runtime.STALLS == 1
    assert logged == [(f"stall for {session} on task t1", {"session_id": session})]
    for tool, output in (
        ("artifact_save", {"type": "artifact", "name": "a.md", "group_id": "g"}),
        ("ask_clarification", {"type": "card", "card": "ask"}),
        ("start_helper", {"started": True, "helper_id": "h"}),
    ):
        await runtime.message_prefix(_server(opened), session, ["go"])
        runtime.on_result(HandlerCtx(tool, None, session), json.dumps(output))
        runtime.turn_ended(session)
    assert runtime.STALLS == 1
    # never watched: a notice, a Helper's wake, a steer while its Helper runs, no open task
    running = {**_OPEN, "helper_running": True}
    for view, texts in (
        (_wire([_OPEN], at=session, by_person=False), ["[System: sub-agent finished]"]),
        (opened, ["[System: timer 1 fired]"]),
        (_wire([running], at=session), ["add pricing"]),
        (_wire([], at=session), ["hi"]),
    ):
        await runtime.message_prefix(_server(view), session, texts)
        assert session not in runtime._watching
        runtime.turn_ended(session)
    # a failed tool is not an ending
    await runtime.message_prefix(_server(opened), session, ["go"])
    runtime.on_result(HandlerCtx("start_helper", None, session), "Error: start_helper: no")
    runtime.turn_ended(session)
    assert runtime.STALLS == 2


def _mcp_proxy(session: str, error: str) -> ProxyMcpManager:
    """The runner's MCP proxy, against a server whose TOOL_CALL gate answers *error*."""

    def handler(request: httpx.Request) -> httpx.Response:
        rpc = json.loads(request.content)
        return httpx.Response(
            200,
            json={"jsonrpc": "2.0", "id": rpc["id"], "error": {"code": -32000, "message": error}},
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")
    return ProxyMcpManager(session, client)


async def _harness_tool_denied(session: str, reason: str) -> None:
    """A harness-native tool call (Pi's bash, a connector tool) the server's gate denies."""

    class _Server:
        async def post(self, _url: str, *, json: dict[str, Any], timeout: Any) -> httpx.Response:
            return httpx.Response(200, json={"result": "POLICY_ACTION_DENY", "reason": reason})

    class _Harness:
        async def post(self, _url: str, *, json: dict[str, Any], timeout: Any) -> httpx.Response:
            return httpx.Response(200, json={})

    await _evaluate_policy_via_omnigent(
        server_client=_Server(),  # type: ignore[arg-type]
        harness_client=_Harness(),  # type: ignore[arg-type]
        conversation_id=session,
        evaluation_id="poleval_test",
        phase="PHASE_TOOL_CALL",
        data={"name": "bash", "arguments": {}},
    )


async def test_a_step_limit_deny_with_no_helper_is_a_stall_even_with_no_task() -> None:
    session = "conv-refused"
    no_task = _wire([], at=session)
    denied = f"Denied by policy: {STEP_LIMIT_REFUSAL}"
    # the proxied call is denied before any handler runs; then a save but no Helper: a stall
    await runtime.message_prefix(_server(no_task), session, ["compare four vendors"])
    out = await _mcp_proxy(session, denied).call_tool(None, "browser_navigate", {})
    assert json.loads(out) == {"error": denied}  # what the model reads
    saved = {"type": "artifact", "name": "a.csv", "group_id": "g"}
    runtime.on_result(HandlerCtx("artifact_save", None, session), json.dumps(saved))
    runtime.turn_ended(session)
    assert runtime.STALLS == 1
    # a harness-native tool denied the same way, then the Helper the refusal asks for: ends well
    await runtime.message_prefix(_server(no_task), session, ["compare four vendors"])
    await _harness_tool_denied(session, STEP_LIMIT_REFUSAL)
    started = {"started": True, "helper_id": "h"}
    runtime.on_result(HandlerCtx("start_helper", None, session), json.dumps(started))
    runtime.turn_ended(session)
    assert runtime.STALLS == 1
    # a harness-native deny with no Helper after it: a stall
    await runtime.message_prefix(_server(no_task), session, ["compare four vendors"])
    await _harness_tool_denied(session, STEP_LIMIT_REFUSAL)
    runtime.turn_ended(session)
    assert runtime.STALLS == 2
    # another policy's deny, or a tool's own error, is not the step limit
    await runtime.message_prefix(_server(no_task), session, ["send it"])
    await _mcp_proxy(session, "Denied by policy: needs approval").call_tool(None, "x", {})
    await _harness_tool_denied(session, "Blocked domain")
    await _mcp_proxy(session, STEP_LIMIT_REFUSAL).call_tool(None, "x", {})  # not a DENY
    runtime.turn_ended(session)
    # a runtime notice's turn is never judged
    notice = _wire([], at=session, by_person=False)
    await runtime.message_prefix(_server(notice), session, ["[System: timer fired]"])
    await _mcp_proxy(session, denied).call_tool(None, "web_fetch", {})
    runtime.turn_ended(session)
    assert runtime.STALLS == 2


# ---------------------------------------------------------------- bounded calls (ADR 0026)


@pytest.fixture()
def unsent(monkeypatch) -> dict[str, list[dict[str, Any]]]:
    queue: dict[str, list[dict[str, Any]]] = {}
    monkeypatch.setattr(runtime, "_unsent", queue)
    monkeypatch.setattr(runtime, "BUDGET", 0.05)
    return queue


def _flaky(failures: list[type[httpx.TransportError]], posted: list[dict[str, Any]], view=None):
    """A server whose next POSTs raise *failures* in turn, then answer; GETs answer *view*."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            seen.append("GET")
            return httpx.Response(200, json=view) if view else httpx.Response(404)
        if failures:
            raise failures.pop(0)("down", request=request)
        posted.append(json.loads(request.content))
        seen.append(posted[-1]["event"])
        return httpx.Response(200, json={"task": None})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")
    return client, seen


_BUILT = {"ok": True, "written": True, "deck": {"title": "T", "look": "Nord"}}


async def test_an_event_that_times_out_is_retried_once(unsent) -> None:
    posted: list[dict[str, Any]] = []
    client, _ = _flaky([httpx.ReadTimeout], posted)
    runtime.on_result(HandlerCtx("deck_new", client, "conv3"), json.dumps(_BUILT))
    await _sent("conv3")
    assert [p["event"] for p in posted] == ["deck_new"] and unsent == {}
    # a refused connection is not retried at once: it waits for the next turn
    client, _ = _flaky([httpx.ConnectError], posted)
    runtime.on_result(HandlerCtx("deck_new", client, "conv3"), json.dumps(_BUILT))
    await _sent("conv3")
    assert len(posted) == 1 and [e["event"] for e in unsent["conv3"]] == ["deck_new"]


async def test_an_unsent_event_goes_in_the_background_at_the_next_turn_then_is_dropped(
    unsent, caplog
) -> None:
    posted: list[dict[str, Any]] = []
    down, _ = _flaky([httpx.ReadTimeout] * 2, posted)
    runtime.on_result(HandlerCtx("deck_new", down, "conv4"), json.dumps(_BUILT))
    await _sent("conv4")
    assert "task event deck_new not sent" in caplog.text and unsent
    # the next turn reads its tasks without waiting for it, and sends it beside the read
    up, seen = _flaky([], posted, _wire([], at="conv4"))
    await runtime.message_prefix(up, "conv4", ["hi"])
    await asyncio.gather(*runtime._flushes)
    assert sorted(seen) == ["GET", "deck_new"] and unsent == {}
    # still down at the next turn: dropped, said so
    down, _ = _flaky([httpx.ReadTimeout] * 2, posted)
    runtime.on_result(HandlerCtx("deck_new", down, "conv4"), json.dumps(_BUILT))
    await _sent("conv4")
    still_down, _ = _flaky([httpx.ConnectError] * 3, posted)
    caplog.clear()
    await runtime.message_prefix(still_down, "conv4", ["hi"])
    await asyncio.gather(*runtime._flushes)
    assert "task event deck_new dropped" in caplog.text and unsent == {}


async def test_a_slow_server_never_holds_a_read_or_an_event(unsent) -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(hang), base_url="http://srv")
    loop = asyncio.get_running_loop()
    start = loop.time()
    assert await runtime.read_tasks(client, "conv5") is None
    runtime.on_result(HandlerCtx("deck_new", client, "conv5"), json.dumps(_BUILT))
    runtime.on_result(
        HandlerCtx("start_helper", client, "conv5"),
        json.dumps({"started": True, "helper_id": "h1"}),
    )
    await _sent("conv5")
    assert loop.time() - start < 1
    assert [e["event"] for e in unsent["conv5"]] == ["deck_new", "start_helper"]


def test_event_calls_have_a_two_second_budget() -> None:
    assert runtime._TIMEOUT.read == 2.0 and runtime._TIMEOUT.connect == 1.0


# ---------------------------------------------------------------- the prefix seam


@pytest.mark.parametrize(
    ("kwargs", "read"),
    [({"helper": True}, False), ({"studio": True}, False), ({}, True)],
    ids=["helper", "studio", "conversation"],
)
async def test_only_the_conversations_turn_reads_the_tasks(monkeypatch, kwargs, read) -> None:
    from omnigent.superchat import features, prompt_prefix

    calls: list[str] = []

    async def prefix(_client, conversation_id: str, _texts) -> list[str]:
        calls.append(conversation_id)
        return []

    swapped = [
        dataclasses.replace(f, message_prefix=prefix) if f.name == "tasks" else f
        for f in features.FEATURES
    ]
    assert next(f for f in swapped if f.name == "tasks").conversation_only
    monkeypatch.setattr(features, "FEATURES", swapped)
    await prompt_prefix.turn_prefix_blocks(None, "s1", message_texts=["go"], **kwargs)
    assert calls == (["s1"] if read else [])


async def test_the_message_prefix_features_are_fetched_together(monkeypatch) -> None:
    from omnigent.superchat import features, prompt_prefix

    started: list[str] = []
    gate = asyncio.Event()

    def slow(name: str):
        async def prefix(_client, _conversation_id: str, _texts) -> list[str]:
            started.append(name)
            if len(started) == 2:
                gate.set()
            await asyncio.wait_for(gate.wait(), 1)  # each waits for the other: only together
            return [name]

        return prefix

    swapped = [
        dataclasses.replace(f, message_prefix=slow(f.name), conversation_only=False)
        for f in features.FEATURES[:2]
    ]
    monkeypatch.setattr(features, "FEATURES", swapped)
    blocks = await prompt_prefix._message_prefix_blocks(None, "s1", ["go"])
    assert blocks == [f.name for f in swapped]


def test_a_turns_end_reaches_every_listening_feature(monkeypatch) -> None:
    from omnigent.superchat import features

    ended: list[str] = []

    def boom(_conversation_id: str) -> None:
        raise RuntimeError("listener failed")

    swapped = [
        dataclasses.replace(features.FEATURES[0], on_turn_end=boom),
        dataclasses.replace(features.FEATURES[1], on_turn_end=ended.append),
    ]
    monkeypatch.setattr(features, "FEATURES", swapped)
    features.notify_turn_end("c1")
    assert ended == ["c1"]
