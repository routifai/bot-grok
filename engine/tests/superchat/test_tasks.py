"""Tasks: what a turn reads in front of the person's message, from the Round record (ADR 0029).

Nothing writes a task from a Helper's start or finish any more: the work still under way is the
Conversation's Rounds whose Helpers still run, and a card's pick is the answer the Round's
message carried.
"""

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

from omnigent.context.labels import ROUND_LABEL_KEY, SCHEDULED_HELPER_LABEL_KEY
from omnigent.entities import MessageData, NewConversationItem
from omnigent.errors import OmnigentError
from omnigent.runner.app import _evaluate_policy_via_omnigent
from omnigent.runner.proxy_mcp_manager import ProxyMcpManager
from omnigent.server.schemas import SessionEventInput
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.cards.handlers import handle_clarification_tool
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.rounds.store import RoundEvent, SqlAlchemyRoundStore
from omnigent.superchat.step_limit.policy import REFUSAL as STEP_LIMIT_REFUSAL
from omnigent.superchat.tasks import runtime
from omnigent.superchat.tasks.record import (
    MAX_LINES,
    CardAnswer,
    Turn,
    ends_well,
    is_stall,
    kind_for_name,
    parse_card_answer,
    prefix_lines,
    round_line,
)
from omnigent.superchat.tasks.routes import create_tasks_router
from omnigent.superchat.tasks.service import TaskService
from omnigent.superchat.tasks.store import SqlAlchemyTaskStore

_MODE = {"omnigent.context.mode": "superside-chat"}

# ---------------------------------------------------------------- the lines (pure)


def _working(ask: str = "Make a deck on Uruguay", *titles: str | None) -> dict[str, Any]:
    helpers = [{"id": f"h{n}", "title": t} for n, t in enumerate(titles or ("Uruguay deck",))]
    return {"round_id": "r1", "ask": ask, "helpers": helpers}


def test_a_working_round_reads_as_one_line_with_what_comes_next() -> None:
    assert round_line(_working()) == (
        'Open task: "Make a deck on Uruguay" · helper "Uruguay deck" · next: wait for the helper'
    )
    two = round_line(_working("Two decks,\n  please", "Deck A", None))
    assert (
        two
        == 'Open task: "Two decks, please" · helper "Deck A" · helper · next: wait for the helper'
    )
    long = round_line(_working("word " * 40))
    assert long.startswith('Open task: "word word') and '…" · helper' in long
    assert round_line({"helpers": []}) == "Open task · next: wait for the helper"


def test_the_pick_comes_first_and_the_lines_are_capped() -> None:
    rounds = [_working(f"Deck {n}") for n in range(8)]
    lines = prefix_lines(rounds, CardAnswer("c1", "pitch-deck", "Pitch Deck"))
    assert lines[0] == "They picked Pitch Deck. Continue the task; do not plan it again."
    assert len(lines) == MAX_LINES and lines[1].startswith('Open task: "Deck 0"')
    assert prefix_lines([], None) == []


def test_a_card_answer_is_read_only_in_its_shape() -> None:
    answer = {"card_id": "c1", "option_id": "nord", "label": "  Nord  "}
    assert parse_card_answer({"card_answer": answer}) == CardAnswer("c1", "nord", "Nord")
    assert parse_card_answer({"card_answer": {**answer, "label": ""}}) is None
    assert parse_card_answer({"card_answer": {"card_id": "c1", "label": "x"}}) is None
    assert parse_card_answer({"open_artifact": {}}) is None
    assert parse_card_answer(None) is None


def test_a_saved_files_kind_is_read_from_its_name() -> None:
    assert [kind_for_name(n) for n in ("a.deck.html", "a.html", "a.md", "a.csv", "a.png")] == [
        "deck",
        "page",
        "document",
        "sheet",
        "file",
    ]


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


# ---------------------------------------------------------------- the service and routes


class _LocalAuth:
    def get_user_id(self, request: Request) -> str | None:
        return None


def _say(conversations: SqlAlchemyConversationStore, chat: str, text: str, **flags: Any) -> str:
    data = MessageData(role="user", content=[{"type": "input_text", "text": text}], **flags)
    (item,) = conversations.append(
        chat, [NewConversationItem(type="message", response_id="resp_1", data=data)]
    )
    return item.id


@dataclasses.dataclass
class _Env:
    client: TestClient
    service: TaskService
    conversations: SqlAlchemyConversationStore
    rounds: SqlAlchemyRoundStore
    chat: str


@pytest.fixture()
def env(db_uri: str) -> _Env:
    """The task service behind its routes, and a Superchat Conversation."""
    conversations = SqlAlchemyConversationStore(db_uri)
    rounds = SqlAlchemyRoundStore(db_uri)
    service = TaskService(SqlAlchemyTaskStore(db_uri), conversations, rounds)
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code}}, status_code=exc.http_status)

    app.include_router(create_tasks_router(service, auth_provider=_LocalAuth()), prefix="/v1")
    chat = conversations.create_conversation(labels=_MODE).id
    return _Env(TestClient(app), service, conversations, rounds, chat)


def _view(env: _Env, session: str | None = None) -> dict[str, Any]:
    return env.client.get(f"/v1/sessions/{session or env.chat}/tasks").json()


def _open_round(env: _Env, text: str) -> str:
    """The person's message *text*, opening a Round: ``round.opened`` and the session's label,
    as ``rounds.record.note_message`` writes them."""
    rid = _say(env.conversations, env.chat, text)
    env.conversations.set_labels(env.chat, {ROUND_LABEL_KEY: rid})
    env.rounds.append([RoundEvent(rid, env.chat, "round.opened", "person", 1, {"text": text})])
    return rid


def _start_helper(env: _Env, rid: str, title: str, **labels: str) -> str:
    """A running Helper started in Round *rid* (``helper.started``, its Round label)."""
    helper = env.conversations.create_conversation(
        kind="sub_agent",
        parent_conversation_id=env.chat,
        labels={**_MODE, ROUND_LABEL_KEY: rid, **labels},
    ).id
    env.conversations.set_session_live_status(helper, "running")
    env.rounds.append(
        [
            RoundEvent(
                rid,
                env.chat,
                "helper.started",
                "assistant",
                2,
                {"helper_id": helper, "title": title},
            )
        ]
    )
    return helper


def _turn_ended(env: _Env, rid: str) -> None:
    env.rounds.append(
        [RoundEvent(rid, env.chat, "turn.ended", "assistant", 3, {"status": "done"})]
    )


def test_a_rounds_running_helper_is_open_work_until_its_session_ends(env: _Env) -> None:
    """The Round view is the source: a Helper started in a Round makes it working, and it stops
    reading as working the moment the Helper's session ends, whether or not its finish reached
    the record, so the turn and the brief never read a stale "building"."""
    rid = _open_round(env, "a deck about our 2026 sales")
    helper = _start_helper(env, rid, "Sales deck")
    _turn_ended(env, rid)
    working = {"round_id": rid, "ask": "a deck about our 2026 sales"}
    assert _view(env)["rounds"] == [
        {**working, "helpers": [{"id": helper, "title": "Sales deck"}]}
    ]
    view = _view(env, helper)
    assert (view["conversation_id"], view["is_helper"], view["round_id"]) == (env.chat, True, rid)
    assert view["message"] == "a deck about our 2026 sales" and view["by_person"] is False
    assert view["background"] is False
    # the next person's message opens its own Round: the Helper's still reads as working
    later = _open_round(env, "and a memo")
    assert [r["round_id"] for r in _view(env)["rounds"]] == [rid]
    assert _view(env)["round_id"] == later
    # the Helper's session ends before its finish is recorded: no longer working
    env.conversations.set_session_live_status(helper, "idle")
    assert _view(env)["rounds"] == []
    # its finish recorded too (the Round settles): still nothing, and no task was ever written
    env.rounds.append(
        [RoundEvent(rid, env.chat, "helper.finished", "helper", 4, {"helper_id": helper})]
    )
    assert _view(env)["rounds"] == [] and env.service.store.list(env.chat) == []
    # a failed Helper is not working either; a scheduled one is background work
    failed = _start_helper(env, later, "Memo")
    env.conversations.set_session_live_status(failed, "failed")
    assert _view(env)["rounds"] == []
    scheduled = _start_helper(env, later, "Report", **{SCHEDULED_HELPER_LABEL_KEY: "t1"})
    assert _view(env, scheduled)["background"] is True


def test_no_writer_is_left_and_an_unknown_session_reads_nothing(env: _Env) -> None:
    for event in ("deck_new", "artifact_save", "start_helper", "turn_start", "turn_end", "x"):
        resp = env.client.post(f"/v1/sessions/{env.chat}/tasks/events", json={"event": event})
        assert resp.status_code == 400, event
    assert env.client.get(f"/v1/sessions/{'f' * 32}/tasks").status_code == 404
    assert env.service.store.list(env.chat) == []


def _answer_message(env: _Env, answer: dict[str, str]):
    """The person's pick, sent as the stored message ``POST .../events`` makes (its Round and
    its ``context``)."""
    from omnigent.server.routes._sessions import orchestration

    body = SessionEventInput(
        type="message",
        data={"role": "user", "content": [{"type": "input_text", "text": answer["label"]}]},
        context={"card_answer": answer},
    )
    conv = env.conversations.get_conversation(env.chat)
    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(orchestration, "ON_MESSAGE_CONTEXT", {"tasks": env.service.message_context})
        return asyncio.run(
            orchestration._persist_user_event_item(env.chat, conv, body, env.conversations)
        )


def test_a_card_answer_is_kept_on_the_message_that_opens_its_round(env: _Env) -> None:
    answer = {"card_id": "ask-1", "option_id": "nord", "label": "Nord"}
    item = _answer_message(env, answer)
    view = _view(env)
    assert view["round_id"] == item.id and view["answer"] == answer and view["by_person"]
    # a Helper the Round started reads the Round's pick (deck_new's look)
    helper = _start_helper(env, item.id, "Deck")
    assert _view(env, helper)["answer"] == answer
    # and a wake turn of the Round still has it, for the look, not as the person's word
    _say(env.conversations, env.chat, "[System: worker/Deck saved a draft]", is_system_notice=True)
    assert (_view(env)["answer"], _view(env)["by_person"]) == (answer, False)
    # the answer lives with the message: a new service (a restart) still reads it
    fresh = TaskService(env.service.store, env.conversations, env.rounds)
    assert fresh.view(env.chat)["answer"] == answer
    # the next Round is another message: the pick is history
    _open_round(env, "and make it short")
    assert _view(env)["answer"] is None


def test_deleting_the_conversation_drops_its_answers(env: _Env) -> None:
    item = _answer_message(env, {"card_id": "c", "option_id": "o", "label": "L"})
    env.service.conversation_deleted(env.chat)
    assert env.service.store.answer(env.chat, item.id) is None


# ---------------------------------------------------------------- the runner side


def _wire(
    rounds: list[dict[str, Any]],
    answer: dict[str, str] | None = None,
    *,
    at: str = "conv1",
    by_person: bool = True,
    round_id: str | None = "r9",
) -> dict[str, Any]:
    return {
        "conversation_id": at,
        "rounds": rounds,
        "answer": answer,
        "by_person": by_person,
        "round_id": round_id,
    }


def _server(view: dict[str, Any] | None):
    def handler(request: httpx.Request) -> httpx.Response:
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


@pytest.fixture(autouse=True)
def _fresh_runtime(monkeypatch) -> None:
    monkeypatch.setattr(runtime, "_turns", {})
    monkeypatch.setattr(runtime, "_posts", {})
    monkeypatch.setattr(runtime, "_unsent", {})
    monkeypatch.setattr(runtime, "_loose", {})
    monkeypatch.setattr(runtime, "STALLS", 0)


async def test_the_turn_gets_the_pick_then_one_line_per_working_round() -> None:
    answer = {"card_id": "c1", "option_id": "pitch-deck", "label": "Pitch Deck"}
    view = _wire([_working()], answer)
    blocks = await runtime.message_prefix(_server(view), "conv1", ["Pitch Deck"])
    assert blocks == [
        "They picked Pitch Deck. Continue the task; do not plan it again.\n"
        'Open task: "Make a deck on Uruguay" · helper "Uruguay deck" · next: wait for the helper'
    ]
    # a wake turn of the pick's Round is not the person's pick again
    wake = _wire([], answer, by_person=False)
    assert await runtime.message_prefix(_server(wake), "conv1", ["[System: x finished]"]) == []
    assert await runtime.message_prefix(_server(_wire([])), "conv1", ["hi"]) == []
    # a view of another conversation (a Helper's root) is not this turn's
    other = _wire([_working()], at="root")
    assert await runtime.message_prefix(_server(other), "conv1", ["go"]) == []
    assert await runtime.message_prefix(_server(None), "conv1", ["hi"]) == []
    assert await runtime.message_prefix(None, "conv1", ["hi"]) == []


async def test_a_card_names_the_round_the_turn_is_in() -> None:
    args = {"question": "Which data?", "options": ["Mock", "Real"]}
    ctx = HandlerCtx("ask_clarification", None, "conv7")
    first = json.loads(await handle_clarification_tool(ctx, args))
    assert "round_id" not in first and first["id"].startswith("ask-")  # the engine's card id
    assert json.loads(await handle_clarification_tool(ctx, args))["id"] != first["id"]
    await runtime.message_prefix(_server(_wire([], at="conv7", round_id="r7")), "conv7", ["go"])
    card = json.loads(await handle_clarification_tool(ctx, args))
    assert card["round_id"] == "r7" and "task_id" not in card
    runtime.turn_ended("conv7")
    assert "round_id" not in json.loads(await handle_clarification_tool(ctx, args))


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


async def test_a_step_limit_deny_with_no_helper_is_a_stall() -> None:
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
    # a runtime notice's turn is never judged, nor a steer while a Round's Helper works
    notice = _wire([], at=session, by_person=False)
    await runtime.message_prefix(_server(notice), session, ["[System: timer fired]"])
    await _mcp_proxy(session, denied).call_tool(None, "web_fetch", {})
    runtime.turn_ended(session)
    await runtime.message_prefix(_server(_wire([_working()], at=session)), session, ["faster"])
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


_CHECKED = {"problems": []}


async def test_an_event_that_times_out_is_retried_once(unsent) -> None:
    posted: list[dict[str, Any]] = []
    client, _ = _flaky([httpx.ReadTimeout], posted)
    runtime.on_result(HandlerCtx("deck_check", client, "conv3"), json.dumps(_CHECKED))
    await _sent("conv3")
    assert [p["event"] for p in posted] == ["evidence"] and unsent == {}
    # a refused connection is not retried at once: it waits for the next turn
    client, _ = _flaky([httpx.ConnectError], posted)
    runtime.on_result(HandlerCtx("deck_check", client, "conv3"), json.dumps(_CHECKED))
    await _sent("conv3")
    assert len(posted) == 1 and [e["event"] for e in unsent["conv3"]] == ["evidence"]


async def test_an_unsent_event_goes_in_the_background_at_the_next_turn_then_is_dropped(
    unsent, caplog
) -> None:
    posted: list[dict[str, Any]] = []
    down, _ = _flaky([httpx.ReadTimeout] * 2, posted)
    runtime.on_result(HandlerCtx("deck_check", down, "conv4"), json.dumps(_CHECKED))
    await _sent("conv4")
    assert "task event evidence not sent" in caplog.text and unsent
    # the next turn reads its view without waiting for it, and sends it beside the read
    up, seen = _flaky([], posted, _wire([], at="conv4"))
    await runtime.message_prefix(up, "conv4", ["hi"])
    await asyncio.gather(*runtime._flushes)
    assert sorted(seen) == ["GET", "evidence"] and unsent == {}
    # still down at the next turn: dropped, said so
    down, _ = _flaky([httpx.ReadTimeout] * 2, posted)
    runtime.on_result(HandlerCtx("deck_check", down, "conv4"), json.dumps(_CHECKED))
    await _sent("conv4")
    still_down, _ = _flaky([httpx.ConnectError] * 3, posted)
    caplog.clear()
    await runtime.message_prefix(still_down, "conv4", ["hi"])
    await asyncio.gather(*runtime._flushes)
    assert "task event evidence dropped" in caplog.text and unsent == {}


async def test_a_dropped_check_is_sent_again_before_the_turns_end(unsent, caplog) -> None:
    """A long ``deck_check`` returned on a connection the server had closed: the post is retried
    at once; still not through, it goes again first at the turn's end, in order."""
    caplog.set_level("INFO", logger="omnigent.superchat.tasks.runtime")
    posted: list[dict[str, Any]] = []
    client, seen = _flaky([httpx.RemoteProtocolError], posted, _wire([], at="conv8"))
    await runtime.message_prefix(client, "conv8", ["go"])
    runtime.on_result(HandlerCtx("deck_check", client, "conv8"), json.dumps({"problems": []}))
    await _sent("conv8")
    assert seen == ["GET", "evidence"] and unsent == {}
    assert "task event evidence connection dropped (RemoteProtocolError) (try 1)" in caplog.text
    # dropped twice: kept, said why, and sent before the turn's end
    client, seen = _flaky([httpx.ReadError] * 2, posted, _wire([], at="conv8"))
    await runtime.message_prefix(client, "conv8", ["go"])
    runtime.on_result(HandlerCtx("deck_check", client, "conv8"), json.dumps({"problems": []}))
    await _sent("conv8")
    assert [e["event"] for e in unsent["conv8"]] == ["evidence"]
    assert "task event evidence not sent (connection dropped (ReadError))" in caplog.text
    runtime.turn_ended("conv8")
    await _sent("conv8")
    assert seen == ["GET", "evidence"] and unsent == {}  # sent at the turn's end
    # a timed-out one too, before the turn is over
    timeout, seen = _flaky([httpx.ReadTimeout] * 2, posted, _wire([], at="conv9"))
    await runtime.message_prefix(timeout, "conv9", ["hi"])
    runtime.on_result(HandlerCtx("deck_check", timeout, "conv9"), json.dumps({"problems": []}))
    await _sent("conv9")
    assert "task event evidence not sent (timed out)" in caplog.text
    runtime.turn_ended("conv9")
    await _sent("conv9")
    assert seen == ["GET", "evidence"] and unsent == {}


async def test_a_slow_server_never_holds_a_read_or_an_event(unsent) -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(hang), base_url="http://srv")
    loop = asyncio.get_running_loop()
    start = loop.time()
    assert await runtime.read_tasks(client, "conv5") is None
    runtime.on_result(HandlerCtx("deck_check", client, "conv5"), json.dumps(_CHECKED))
    runtime.on_result(HandlerCtx("deck_check", client, "conv5"), json.dumps(_CHECKED))
    await _sent("conv5")
    assert loop.time() - start < 1
    assert [e["event"] for e in unsent["conv5"]] == ["evidence", "evidence"]


def test_event_calls_have_a_two_second_budget() -> None:
    assert runtime._TIMEOUT.read == 2.0 and runtime._TIMEOUT.connect == 1.0


# ---------------------------------------------------------------- the prefix seam


@pytest.mark.parametrize(
    ("kwargs", "read"),
    [({"helper": True}, False), ({"studio": True}, False), ({}, True)],
    ids=["helper", "studio", "conversation"],
)
async def test_only_the_conversations_turn_reads_the_view(monkeypatch, kwargs, read) -> None:
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


# ---------------------------------------------------- the runner and the server together


async def test_the_runner_reads_a_working_round_until_its_helper_ends(env: _Env) -> None:
    """Live, through the real routes: the person's pick starts a Helper; the wake turn's prefix
    reads that Round as working while the Helper runs, and nothing once it has ended."""
    engine = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=env.client.app), base_url="http://srv"
    )
    rid = _open_round(env, "a new RBC vs TD deck")
    helper = _start_helper(env, rid, "RBC vs TD deck")
    _turn_ended(env, rid)
    later = _open_round(env, "what about the colours?")
    blocks = await runtime.message_prefix(engine, env.chat, ["what about the colours?"])
    assert blocks == [
        'Open task: "a new RBC vs TD deck" · helper "RBC vs TD deck" · next: wait for the helper'
    ]
    assert runtime.current_round(env.chat) == later
    runtime.turn_ended(env.chat)
    env.conversations.set_session_live_status(helper, "idle")
    notice = "[System: worker/RBC vs TD deck finished]"
    _say(env.conversations, env.chat, notice, is_system_notice=True)
    assert await runtime.message_prefix(engine, env.chat, [notice]) == []
    assert env.service.store.list(env.chat) == []
