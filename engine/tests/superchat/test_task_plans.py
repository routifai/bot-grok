"""The plan is ticked by evidence, never by the model (ADR 0027): the rule, the record, the runner,
the transcript and the activity projections."""

from __future__ import annotations

import json
import types
from typing import Any

import httpx
import pytest

from omnigent.context.state_file import entry_label_key
from omnigent.entities import (
    Conversation,
    ConversationItem,
    FunctionCallData,
    FunctionCallOutputData,
    MessageData,
)
from omnigent.superchat.activity.derive import (
    _activities_for_conversation,
    activity_to_dict,
    summary_line,
)
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.tasks import runtime
from omnigent.superchat.tasks.record import (
    Task,
    checked,
    decision_line,
    evidence_for,
    fold,
    plan_views,
    plans_from_items,
    project,
    replay,
    tick,
)
from omnigent.superchat.transcript.blocks import project_items
from tests.superchat.test_tasks import _answer_message, _ask, _helper, _say, make_env

_ITEMS = [
    {"text": "Read what you made before", "done_when": "brief", "status": "done"},
    {"text": "Build the deck", "active": "Building the deck", "owner": "helper"},
    {"text": "Save it", "done_when": "saved"},
    {"text": "Check it", "done_when": "check_ran", "status": "done"},
]


def _plan(
    items: list[dict[str, Any]] | None = None, *, kind: str | None = "deck"
) -> dict[str, Any]:
    made = tick(None, {"kind": "plan", "id": "p1", "items": items or _ITEMS})
    assert made is not None
    return {**made, "kind": kind} if kind else made


def _states(plan: dict[str, Any] | None, **kwargs: Any) -> list[str]:
    return [item["state"] for item in project(plan, **kwargs)]


def _out(value: dict[str, Any] | str) -> str:
    return value if isinstance(value, str) else json.dumps(value)


# ---------------------------------------------------------------- the rule (pure)


def test_a_tick_the_model_claimed_is_not_done() -> None:
    # ADR 0027: "The model never ticks a step." Its "done" reads claimed until evidence comes.
    plan = _plan()
    assert _states(plan, running=True) == ["claimed", "todo", "todo", "claimed"]
    plan = tick(plan, {"kind": "brief"})
    assert _states(plan, running=True)[0] == "done"


@pytest.mark.parametrize(
    ("done_when", "tool", "output"),
    [
        ("brief", "context_brief", "You made a deck on this in May."),
        ("read", "files_search", {"type": "file_search", "results": []}),
        ("read", "recall", {"results": []}),
        ("read", "context_brief", "Nothing yet."),  # a brief reads when no step is a brief
        ("saved", "artifact_save", {"type": "artifact", "name": "a.deck.html", "id": "a"}),
    ],
)
def test_each_kind_of_evidence_ticks_its_step(
    done_when: str, tool: str, output: dict[str, Any] | str
) -> None:
    plan = _plan([{"text": "Step", "done_when": done_when}, {"text": "Other"}])
    event = evidence_for(tool, _out(output))
    assert event is not None
    assert _states(tick(plan, event), running=True) == ["done", "todo"]
    assert _states(
        tick(_plan([{"text": "Ask", "done_when": "answered"}]), {"kind": "answered"})
    ) == ["done"]


def test_a_check_counts_only_after_the_build() -> None:
    plan = _plan([{"text": "Check", "done_when": "check_ran"}])
    check = evidence_for("deck_check", '{"problems": []}')
    assert check == {"kind": "check", "tool": "deck_check"}
    assert _states(tick(plan, check), running=True) == ["todo"]
    for build in (
        evidence_for("deck_new", '{"deck": {"title": "T"}}'),
        {"kind": "saved", "name": "a.deck.html"},
    ):
        assert build is not None
        assert _states(tick(tick(plan, build), check)) == ["done"]


def test_a_save_lists_the_output_once_and_names_the_deliverable() -> None:
    plan = _plan(kind=None)
    for _ in range(2):
        plan = tick(plan, {"kind": "saved", "name": "q3.deck.html", "artifact_id": "a1"})
    assert plan["outputs"] == [{"name": "q3.deck.html", "artifact_id": "a1"}]
    assert plan["kind"] == "deck"


def test_a_helper_makes_its_step_doing_and_its_finish_settles_it() -> None:
    plan = tick(_plan(), {"kind": "helper_started", "helper_id": "h1"})
    assert plan["items"][1]["helper_id"] == "h1"
    assert _states(plan, running=True)[1] == "doing"
    assert _states(tick(plan, {"kind": "helper_done", "helper_id": "h1", "ok": True}))[1] == "done"
    failed = tick(plan, {"kind": "helper_done", "helper_id": "h1", "ok": False})
    assert _states(failed)[1] == "failed"
    # a second Helper takes no step that already has one
    assert tick(plan, {"kind": "helper_started", "helper_id": "h2"}) == plan


def test_a_helper_that_finishes_without_its_check_leaves_the_check_not_checked() -> None:
    # The reviewer's case: a Helper fixes the deck and finishes without running deck_check.
    items = [
        {"text": "Brief", "done_when": "brief"},
        {"text": "Fix the deck", "owner": "me", "done_when": "saved"},
        {"text": "Check it", "owner": "helper", "done_when": "check_ran"},
    ]
    plan = tick(_plan(items), {"kind": "helper_started", "helper_id": "h1"})
    assert "helper_id" not in plan["items"][2]  # a Helper never takes the check step
    plan = tick(plan, {"kind": "built", "deliverable": "deck"})
    plan = tick(plan, {"kind": "helper_done", "helper_id": "h1", "ok": True})
    assert _states(plan, helpers={"h1": "done"})[2] == "not_checked"
    # a Helper's step whose criterion is a save is not done by the Helper finishing
    saving = [{"text": "Build and save", "owner": "helper", "done_when": "saved"}]
    plan = tick(_plan(saving), {"kind": "helper_started", "helper_id": "h2"})
    plan = tick(plan, {"kind": "helper_done", "helper_id": "h2", "ok": True})
    assert plan["items"][0]["evidence"] == "doing"
    assert _states(plan, helpers={"h2": "done"}) == ["stopped"]


def test_a_helpers_status_settles_its_step_before_the_record_hears() -> None:
    plan = tick(_plan(), {"kind": "helper_started", "helper_id": "h1"})
    assert _states(plan, helpers={"h1": "in_progress"})[1] == "doing"
    assert _states(plan, helpers={"h1": "done"})[1] == "done"
    assert _states(plan, helpers={"h1": "failed"})[1] == "failed"


def test_a_check_with_nothing_behind_it_reads_not_checked_once_nothing_runs() -> None:
    plan = _plan()
    assert _states(plan, running=True)[3] == "claimed"
    assert _states(plan)[3] == "not_checked"  # what the model claimed counts for nothing
    helping = tick(plan, {"kind": "helper_started", "helper_id": "h1"})
    # the turn ended but its Helper still works: the check may still come
    assert _states(helping, helpers={"h1": "in_progress"})[3] == "claimed"


def test_only_a_deliverable_with_a_check_tool_reads_not_checked() -> None:
    page = _plan(
        [{"text": "Save", "done_when": "saved"}, {"text": "Check", "done_when": "check_ran"}]
    )
    page = tick({**page, "kind": None}, {"kind": "saved", "name": "launch.html"})
    assert page["kind"] == "page"
    assert _states(page) == ["done", "todo"]
    assert _states(tick(page, {"kind": "check", "tool": "deck_check"})) == ["done", "done"]


def test_a_step_still_doing_when_nothing_runs_reads_stopped() -> None:
    plan = tick(_plan(), {"kind": "helper_started", "helper_id": "h1"})
    assert _states(plan, running=True)[1] == "doing"
    assert _states(plan)[1] == "stopped"


def test_a_later_render_adds_and_rewords_but_never_changes_state() -> None:
    plan = tick(_plan(), {"kind": "brief"})
    again = [
        {"text": "Read the brief", "status": "todo"},
        {"text": "Build it", "status": "done"},
        *_ITEMS[2:],
        {"text": "Hand it back"},
    ]
    plan = tick(plan, {"kind": "plan", "id": "p1", "items": again})
    shown = project(plan, running=True)
    assert [i["text"] for i in shown][:2] == ["Read the brief", "Build it"]
    assert [i["state"] for i in shown] == ["done", "todo", "todo", "claimed", "todo"]
    other = tick(plan, {"kind": "plan", "id": "p2", "items": [{"text": "New"}]})
    assert other is not None and other["id"] == "p2" and len(other["items"]) == 1


def test_evidence_before_the_plan_counts_for_it() -> None:
    plan = replay([{"kind": "brief"}, {"kind": "plan", "id": "p1", "items": _ITEMS}])
    assert _states(plan, running=True)[0] == "done"
    assert tick(None, {"kind": "brief"}) is None


def test_the_projection_keeps_the_models_fields_never_its_status() -> None:
    (item,) = project(
        _plan([{"text": "Build", "active": "Building", "owner": "helper", "status": "done"}])
    )
    assert item == {"text": "Build", "active": "Building", "owner": "helper", "state": "claimed"}
    assert project(None) == []


def test_the_leading_done_steps_fold_but_two() -> None:
    def items(*states: str) -> list[dict[str, str]]:
        return [{"state": s} for s in states]

    assert fold(items("done", "done", "done", "done", "doing")) == 2
    assert fold(items("done", "done", "todo")) == 0
    assert fold(items("claimed", "done", "done", "done")) == 0


def test_which_results_are_evidence() -> None:
    card = {"type": "card", "card": "plan", "id": "p1", "data": {"items": _ITEMS}}
    assert evidence_for("mcp__omnigent__render_card", _out(card)) == {
        "kind": "plan",
        "id": "p1",
        "title": None,
        "items": _ITEMS,
    }
    # a plan card with no id is named by its call
    bare = {**card, "id": None}
    assert evidence_for("render_card", _out(bare), call_id="call_9")["id"] == "call_9"  # type: ignore[index]
    assert evidence_for("render_card", _out(bare)) is None
    assert evidence_for("render_card", _out({**card, "card": "sources"})) is None
    # only a structured error is a failure: plain text is a result
    assert evidence_for("context_brief", "Error rates fell in May.") == {"kind": "brief"}
    assert evidence_for("deck_check", '{"error": "no deck"}') is None
    assert evidence_for("deck_check", "") is None
    assert evidence_for("start_helper", '{"started": true, "helper_id": "h"}') == {
        "kind": "helper_started",
        "helper_id": "h",
    }
    assert evidence_for("web_search", "{}") is None


def test_a_finished_task_leaves_one_decision_line() -> None:
    plan = tick(tick(_plan(), {"kind": "built"}), {"kind": "check", "tool": "deck_check"})
    task = Task("t", "o", "c", "deck", "RBC vs TD", {"look": "Swiss Grid", "slides": 6})
    task.fields["data"] = "mock"
    task.fields["plan"] = plan
    assert decision_line(task) == "RBC vs TD (deck): look Swiss Grid, data mock, 6 slides, checked"
    task.fields["plan"] = _plan()
    assert decision_line(task).endswith(", not checked")
    memo = Task("t", "o", "c", "document", "Provisions memo", {})
    assert decision_line(memo) == "Provisions memo (document)"  # no check tool, no check word
    assert checked(None) is None


def _item(raw_id: str, role: str, text: str) -> dict[str, Any]:
    kind = "input_text" if role == "user" else "output_text"
    return {
        "id": raw_id,
        "type": "message",
        "role": role,
        "content": [{"type": kind, "text": text}],
    }


def _call(call_id: str, name: str, output: dict[str, Any] | str | None, **args: Any):
    items: list[dict[str, Any]] = [
        {
            "id": f"fc_{call_id}",
            "type": "function_call",
            "name": name,
            "call_id": call_id,
            "arguments": json.dumps(args),
        }
    ]
    if output is not None:
        items.append(
            {
                "id": f"fo_{call_id}",
                "type": "function_call_output",
                "call_id": call_id,
                "output": _out(output),
            }
        )
    return items


def _plan_card(items: list[dict[str, Any]] = _ITEMS, plan_id: str | None = "p1") -> dict[str, Any]:
    card = {"type": "card", "card": "plan", "data": {"items": items}, "fallback": "Plan"}
    return {**card, "id": plan_id} if plan_id else card


def _turn() -> list[dict[str, Any]]:
    return [
        _item("u1", "user", "a deck on RBC vs TD"),
        *_call("c0", "context_brief", "Nothing made before."),
        *_call("c1", "render_card", _plan_card()),
        *_call("c2", "start_helper", {"started": True, "helper_id": "h1", "title": "Deck"}),
        _item("a1", "assistant", "Building the RBC vs TD deck now."),
    ]


def test_an_answer_to_the_plans_question_keeps_ticking_it() -> None:
    items = [
        *_call("c1", "render_card", _plan_card([{"text": "Ask", "done_when": "answered"}])),
        *_call("c2", "ask_clarification", {"type": "card", "card": "ask"}),
        _item("u2", "user", "Nord"),
    ]
    assert plans_from_items(items)["p1"]["items"][0]["evidence"] == "done"


def test_the_plan_views_prefer_the_record_and_name_an_id_less_plan_by_its_call() -> None:
    items = _turn()
    views = plan_views({}, items, running=True, helpers={})
    assert [i["state"] for i in views["p1"]] == ["done", "doing", "todo", "claimed"]
    stored = {"p1": {**plans_from_items(items)["p1"], "items": []}}
    assert plan_views(stored, items, running=True, helpers={})["p1"] == []
    bare = [*_call("c7", "render_card", _plan_card([{"text": "Step"}], plan_id=None))]
    assert list(plan_views({}, bare, running=False, helpers={})) == ["c7"]


# ---------------------------------------------------------------- the record (service)


@pytest.fixture()
def env(db_uri: str):
    return make_env(db_uri)


def _event(client, session: str, **body: Any) -> dict[str, Any] | None:
    resp = client.post(f"/v1/sessions/{session}/tasks/events", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["task"]


def _events(client, session: str, **body: Any) -> dict[str, Any]:
    resp = client.post(f"/v1/sessions/{session}/tasks/events", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_plan_with_no_deliverable_makes_no_task(env) -> None:
    client, service, conversations, chat = env
    _say(conversations, chat, "What should I read about rate cuts?")
    assert _event(client, chat, event="plan", id="p1", items=_ITEMS) is None
    view = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert view["tasks"] == [] and service.store.list(chat) == []


def test_the_task_keeps_the_plan_and_the_evidence_ticks_it(env) -> None:
    client, service, conversations, chat = env
    _say(conversations, chat, "Create some presentation about RBC vs TD")
    helper = _helper(conversations, chat)
    started = _event(client, chat, event="start_helper", helper_id=helper, title="RBC vs TD deck")
    assert started is not None
    # the plan joins the task the deliverable made, with the brief the turn read before it
    task = _event(
        client,
        chat,
        event="plan",
        id="p1",
        items=_ITEMS,
        task_id=started["id"],
        evidence=[{"kind": "brief"}],
    )
    assert task is not None and task["id"] == started["id"]
    plan = task["fields"]["plan"]
    assert plan["kind"] == "deck"
    assert [i["evidence"] for i in plan["items"]] == ["done", "todo", "todo", "todo"]
    # a Helper started before the plan took no step; the next one does
    helper2 = _helper(conversations, chat)
    second = _event(client, chat, event="start_helper", helper_id=helper2, title="RBC vs TD deck")
    assert second["fields"]["plan"]["items"][1]["helper_id"] == helper2
    # the Helper's draft and its check land on the plan
    _event(client, helper2, event="deck_new", title="RBC vs TD", written=True)
    _event(
        client, helper2, event="artifact_save", name="rbc.deck.html", group_id="g", artifact_id="a"
    )
    checked_task = _event(client, helper2, event="evidence", kind="check", tool="deck_check")
    items = checked_task["fields"]["plan"]["items"]
    assert [i["evidence"] for i in items] == ["done", "doing", "done", "done"]
    assert checked_task["fields"]["plan"]["outputs"] == [
        {"name": "rbc.deck.html", "artifact_id": "a", "title": "rbc.deck.html"}
    ]
    # the same check again changes nothing and saves nothing
    assert _event(client, helper2, event="evidence", kind="check", tool="deck_check") is None
    # a re-render keeps the evidence
    again = _event(
        client, chat, event="plan", id="p1", items=[{"text": "Brief"}], task_id=started["id"]
    )
    assert again["fields"]["plan"]["items"][0] == {**items[0], "text": "Brief"}
    # the Helpers finish: a read never closes the task, the turn's start does
    for h in (helper, helper2):
        conversations.set_session_live_status(h, "idle")
    view = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert view["tasks"] == [] and view["done"] == []
    assert service.store.get(started["id"]).status == "building"
    reply = _events(client, chat, event="turn_start")
    (closed,) = reply["closed"]
    assert (
        closed["status"] == "done" and closed["fields"]["plan"]["items"][1]["evidence"] == "done"
    )
    line = "RBC vs TD deck (deck): checked"
    assert closed["fields"]["decision"] == line
    tag_key = entry_label_key("d-rbc-vs-td-deck")
    assert conversations.get_conversation(chat).labels[tag_key] == line
    assert _events(client, chat, event="turn_start")["closed"] == []
    assert [t["id"] for t in client.get(f"/v1/sessions/{chat}/tasks").json()["done"]] == [
        started["id"]
    ]
    assert service.recent_done(chat, 1)[0].fields["decision"] == line
    assert _event(client, chat, event="evidence", kind="nonsense") is None


def test_a_turns_end_answers_with_every_task_it_closed(env) -> None:
    client, _service, conversations, chat = env
    _say(conversations, chat, "a memo and a sheet")
    _event(client, chat, event="artifact_save", name="memo.md", group_id="g1")
    _event(client, chat, event="artifact_save", name="numbers.csv", group_id="g2")
    reply = _events(client, chat, event="turn_end")
    assert sorted(t["kind"] for t in reply["closed"]) == ["document", "sheet"]
    assert all(t["fields"]["decision"] for t in reply["closed"])
    assert reply["task"] == reply["closed"][0]


def test_a_card_answer_ticks_the_answered_step(env) -> None:
    client, service, conversations, chat = env
    made = _event(client, chat, event="deck_new", title="Q3", look="Nord")
    task = _event(
        client,
        chat,
        event="plan",
        id="p1",
        items=[{"text": "Ask", "done_when": "answered"}],
        task_id=made["id"],
    )
    card_id = _ask(conversations, chat, task["id"])
    _answer_message(
        conversations, chat, service, {"card_id": card_id, "option_id": "n", "label": "Nord"}
    )
    plan = service.store.get(task["id"]).fields["plan"]
    assert plan["items"][0]["evidence"] == "done"


def test_the_service_projects_with_the_live_session_and_helpers(env) -> None:
    client, service, conversations, chat = env
    helper = _helper(conversations, chat)
    made = _event(client, chat, event="start_helper", helper_id=helper, title="RBC vs TD deck")
    _event(client, chat, event="plan", id="p1", items=_ITEMS, task_id=made["id"])
    other = _helper(conversations, chat)
    _event(client, chat, event="start_helper", helper_id=other, title="x")
    items = [
        *_call("c1", "render_card", _plan_card()),
        *_call("c2", "start_helper", {"started": True, "helper_id": other}),
    ]
    views = service.plan_views(chat, items)
    assert views["p1"][1]["state"] == "doing"  # its Helper is running
    assert views["p1"][3]["state"] == "claimed"
    conversations.set_session_live_status(other, "idle")
    views = service.plan_views(chat, items)
    assert views["p1"][1]["state"] == "done"  # read now, before the record hears
    assert views["p1"][3]["state"] == "not_checked"  # a deck, nothing running, no check


# ---------------------------------------------------------------- the runner


def _server(view: dict[str, Any], posted: list[dict[str, Any]], answers=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            body = json.loads(request.content)
            posted.append(body)
            return httpx.Response(200, json=(answers or {}).get(body["event"], {"task": None}))
        return httpx.Response(200, json=view)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://srv")


@pytest.fixture(autouse=True)
def _fresh_runtime(monkeypatch) -> None:
    monkeypatch.setattr(runtime, "_turns", {})
    monkeypatch.setattr(runtime, "_watching", {})
    monkeypatch.setattr(runtime, "_posts", {})
    monkeypatch.setattr(runtime, "_unsent", {})


async def _sent(session: str) -> None:
    seen = None
    while (pending := runtime._posts.get(session)) is not None and pending is not seen:
        seen = pending
        await pending


def _ran(client, session: str, tool: str, output: dict[str, Any] | str) -> None:
    runtime.on_result(HandlerCtx(tool, client, session), _out(output))


async def test_a_turns_plan_waits_for_its_deliverable_and_carries_its_early_brief() -> None:
    posted: list[dict[str, Any]] = []
    view = {"conversation_id": "c1", "tasks": [], "by_person": True}
    made = {"task": {"id": "t1", "status": "building"}}
    client = _server(view, posted, {"start_helper": made})
    await runtime.message_prefix(client, "c1", ["a deck"])
    _ran(client, "c1", "context_brief", "You made a deck on this in May.")
    items = [*_ITEMS, {"text": "Read the notes", "done_when": "read"}]
    _ran(client, "c1", "render_card", _plan_card(items))
    _ran(client, "c1", "files_search", {"type": "file_search", "results": []})
    _ran(client, "c1", "files_search", {"type": "file_search", "results": []})  # ticks nothing
    await _sent("c1")
    assert posted == []  # no deliverable yet: the plan joins no task
    _ran(client, "c1", "start_helper", {"started": True, "helper_id": "h1", "title": "Deck"})
    await _sent("c1")
    await _sent("c1")
    assert [p["event"] for p in posted] == ["start_helper", "plan", "evidence"]
    assert posted[1]["evidence"] == [{"kind": "brief"}] and posted[1]["task_id"] == "t1"
    assert posted[2] == {"event": "evidence", "kind": "read", "task_id": "t1"}


async def test_a_plan_with_no_deliverable_is_never_sent() -> None:
    posted: list[dict[str, Any]] = []
    client = _server({"conversation_id": "c3", "tasks": [], "by_person": True}, posted)
    await runtime.message_prefix(client, "c3", ["what should I read?"])
    _ran(client, "c3", "render_card", _plan_card())
    runtime.turn_ended("c3")
    await _sent("c3")
    assert [p["event"] for p in posted] == ["turn_end"]
    assert runtime._watching == {}


async def test_a_helpers_check_is_sent_at_once_and_its_reads_never() -> None:
    posted: list[dict[str, Any]] = []
    client = _server({}, posted)
    _ran(client, "helper1", "deck_check", {"problems": []})
    _ran(client, "helper1", "deck_check", {"error": "no deck"})
    _ran(client, "helper1", "files_search", {"type": "file_search", "results": []})
    await _sent("helper1")
    assert posted == [
        {"event": "evidence", "kind": "check", "tool": "deck_check", "task_id": None}
    ]


async def test_the_tasks_a_turn_closes_are_journaled(monkeypatch) -> None:
    seen: list[tuple[str, str]] = []

    async def journal(conversation_id: str, task: dict[str, Any]) -> None:
        seen.append((conversation_id, task["id"]))

    monkeypatch.setattr(runtime, "journal_decision", journal)
    closed = {"id": "t1", "kind": "deck", "title": "T", "status": "done", "fields": {}}
    finished = {"id": "t2", "status": "building", "helper_ids": ["h"], "helper_running": False}
    view = {"conversation_id": "c2", "tasks": [finished], "by_person": False}
    posted: list[dict[str, Any]] = []
    answers = {
        "turn_start": {"task": closed, "closed": [closed]},
        "turn_end": {"task": None, "closed": [{**closed, "id": "t3"}]},
    }
    client = _server(view, posted, answers)
    await runtime.message_prefix(client, "c2", ["[helper] done"])
    runtime.turn_ended("c2")
    await _sent("c2")
    for job in list(runtime._journals):
        await job
    assert [p["event"] for p in posted] == ["turn_start", "turn_end"]
    assert seen == [("c2", "t1"), ("c2", "t3")]


# ---------------------------------------------------------------- the projections


def test_the_transcript_shows_the_engines_items() -> None:
    items = _turn()
    views = plan_views({}, items, running=True, helpers={})
    card = next(
        b
        for m in project_items(items, plan_views=views)
        for b in m["blocks"]
        if b["type"] == "card"
    )
    shown = card["card"]["data"]["items"]
    assert [i["state"] for i in shown] == ["done", "doing", "todo", "claimed"]
    assert "status" not in shown[0] and shown[1]["active"] == "Building the deck"
    ended = plan_views({}, items, running=False, helpers={})
    card = next(
        b
        for m in project_items(items, plan_views=ended)
        for b in m["blocks"]
        if b["type"] == "card"
    )
    assert [i["state"] for i in card["card"]["data"]["items"]] == [
        "done",
        "stopped",
        "todo",
        "claimed",  # the transcript alone does not know the deliverable: no "Not checked"
    ]
    plain = next(b for m in project_items(items) for b in m["blocks"] if b["type"] == "card")
    assert plain["card"]["data"]["items"] == _ITEMS


@pytest.mark.parametrize(
    ("calls", "line"),
    [
        ([], None),
        ([("render_card", "{}")], None),
        ([("web_search", "{}")], "Searched the web"),
        ([("context_brief", "{}")], "Checked what we already have"),
        ([("recall", "{}"), ("memory_search", "{}")], "Recalled earlier work"),
        ([("artifact_save", '{"path": "/w/a.html"}')], "Created 1 file"),
        (
            [("artifact_save", '{"path": "a.html"}'), ("artifact_save", '{"path": "a.html"}')],
            "Created 1 file",
        ),
        (
            [("artifact_save", '{"path": "a.html"}'), ("web_search", "{}")],
            "Created 1 file and searched the web",
        ),
        ([("deck_theme_set", "{}")] * 3, "3 steps"),
        ([("web_search", "{}"), ("deck_new", "{}")], "Searched the web and 1 more step"),
        (
            [
                ("web_search", "{}"),
                ("artifact_save", '{"path": "a.deck.html"}'),
                ("artifact_save", '{"path": "b.html"}'),
                *[("sys_os_bash", "{}")] * 4,
                *[("deck_new", "{}")] * 8,
                ("render_card", "{}"),
            ],
            "Created 2 files, searched the web, and 12 more steps",
        ),
    ],
)
def test_the_summary_line(calls: list[tuple[str, str]], line: str | None) -> None:
    assert summary_line(calls) == line


class _Store:
    def __init__(self, items: list[ConversationItem]) -> None:
        self.items = items

    def get_activity_labels(self, _ids: list[str]) -> dict[str, tuple[str, str | None]]:
        return {}

    def list_items(self, _conversation_id: str, limit: int = 1000, order: str = "asc"):
        return types.SimpleNamespace(
            data=(self.items if order == "asc" else list(reversed(self.items)))[:limit]
        )


def _conversation_item(raw: dict[str, Any], at: int) -> ConversationItem:
    if raw["type"] == "function_call":
        data: Any = FunctionCallData(
            agent="a", name=raw["name"], arguments=raw["arguments"], call_id=raw["call_id"]
        )
    elif raw["type"] == "function_call_output":
        data = FunctionCallOutputData(call_id=raw["call_id"], output=raw["output"])
    else:
        agent = "a" if raw["role"] == "assistant" else None
        data = MessageData(role=raw["role"], content=raw["content"], agent=agent)
    return ConversationItem(
        id=raw["id"],
        type=raw["type"],
        status="completed",
        response_id="r1",
        created_at=at,
        data=data,
    )


def test_the_activity_carries_the_summary_line_the_fold_and_the_plan() -> None:
    items = [_conversation_item(raw, at) for at, raw in enumerate(_turn(), start=1)]
    conversation = Conversation(id="chat", created_at=1, updated_at=1, root_conversation_id="chat")
    asked: list[str] = []

    def views(conversation_id: str, flat: list[Any]) -> dict[str, list[dict[str, Any]]]:
        asked.append(conversation_id)
        return plan_views({}, flat, running=False, helpers={"h1": "in_progress"})

    (activity,) = _activities_for_conversation(
        _Store(items),  # type: ignore[arg-type]
        conversation,
        include_step_detail=False,
        plan_views=views,
    )
    wire = activity_to_dict(activity)
    assert asked == ["chat"]
    assert wire["summary_line"] == "Checked what we already have and started a helper"
    assert [i["state"] for i in wire["plan"]] == ["done", "doing", "todo", "claimed"]
    assert wire["fold"] == 0

    def all_done(_c: str, _flat: list[Any]) -> dict[str, list[dict[str, Any]]]:
        return {"p1": [{"text": t, "state": "done"} for t in "abcd"]}

    (activity,) = _activities_for_conversation(
        _Store(items),  # type: ignore[arg-type]
        conversation,
        include_step_detail=False,
        plan_views=all_done,
    )
    assert activity.fold == 2
    (plain,) = _activities_for_conversation(
        _Store(items),  # type: ignore[arg-type]
        conversation,
        include_step_detail=False,
    )
    assert plain.plan is None and plain.fold == 0


# ---------------------------------------------------------------- what the web reads


def test_each_reply_names_its_activity_and_the_plan_its_fold() -> None:
    items = [{**raw, "response_id": "resp_7"} for raw in _turn()]
    views = {"p1": [{"text": t, "state": "done"} for t in "abcd"]}
    messages = project_items(items, plan_views=views, conversation_id="chat")
    replies = [m for m in messages if m["role"] == "assistant"]
    assert replies and all(m["activity_id"] == "turn:chat:resp_7" for m in replies)
    assert all("activity_id" not in m for m in messages if m["role"] == "user")
    card = next(b for m in messages for b in m["blocks"] if b["type"] == "card")
    assert card["fold"] == fold(views["p1"]) == 2
    assert "activity_id" not in project_items(items)[1]


def test_a_comment_on_a_step_is_kept_on_it_and_read_by_the_turn_it_opens(env) -> None:
    client, service, conversations, chat = env
    made = _event(client, chat, event="deck_new", title="Q3", look="Nord")
    _event(client, chat, event="plan", id="p1", items=_ITEMS, task_id=made["id"])
    comment = {"card_id": "p1", "step_index": 1, "text": "  Use the  Q2 numbers "}
    item = _say(conversations, chat, "go on")
    service.message_context(chat, item, {"step_comment": comment})
    plan = service.store.get(made["id"]).fields["plan"]
    assert plan["items"][1]["comments"] == ["Use the Q2 numbers"]
    assert project(plan)[1]["comments"] == ["Use the Q2 numbers"]
    view = client.get(f"/v1/sessions/{chat}/tasks").json()
    assert view["comment"] == {"step": "Build the deck", "text": "Use the Q2 numbers"}
    # a step that does not exist, or another plan, keeps nothing
    service.message_context(chat, item, {"step_comment": {**comment, "step_index": 9}})
    service.message_context(chat, item, {"step_comment": {**comment, "card_id": "p9"}})
    assert service.store.get(made["id"]).fields["plan"]["items"][1]["comments"] == [
        "Use the Q2 numbers"
    ]
    # one message later the comment is history
    _say(conversations, chat, "and shorter")
    assert client.get(f"/v1/sessions/{chat}/tasks").json()["comment"] is None


async def test_the_comment_goes_in_front_of_the_task_lines() -> None:
    task = {"id": "t1", "kind": "deck", "title": "Q3", "status": "open", "fields": {}}
    view = {
        "conversation_id": "c4",
        "tasks": [task],
        "by_person": True,
        "comment": {"step": "Build the deck", "text": "Use the Q2 numbers"},
    }
    (block,) = await runtime.message_prefix(_server(view, []), "c4", ["go on"])
    assert block.split("\n") == [
        'About the step "Build the deck": Use the Q2 numbers',
        'Open task: deck "Q3" · next: build',
    ]


def test_each_step_has_its_kind_and_the_activity_its_families() -> None:
    raw = [
        _item("u1", "user", "a deck"),
        *_call("c0", "context_brief", "[Context brief: data]\n2 things made before.\n- x"),
        *_call("c1", "web_search", {"results": []}),
        *_call("c2", "deck_new", {"deck": {"title": "T"}}),
        *_call("c3", "artifact_outline", {"name": "q3.deck.html", "outline": "..."}),
        *_call("c4", "artifact_outline", {"error": "gone"}),
        *_call("c5", "sys_os_bash", "ok"),
        _item("a1", "assistant", "Done."),
    ]
    items = [_conversation_item(r, at) for at, r in enumerate(raw, start=1)]
    conversation = Conversation(id="chat", created_at=1, updated_at=1, root_conversation_id="chat")
    (activity,) = _activities_for_conversation(
        _Store(items),  # type: ignore[arg-type]
        conversation,
        include_step_detail=False,
    )
    wire = activity_to_dict(activity)
    steps = wire["steps"]
    assert [s.get("kind") for s in steps] == ["brief", "web", None, None, None, "command"]
    assert steps[0]["title"] == "Checked what we already have"
    assert steps[0]["snippet"] == "2 things made before."
    assert [s["title"] for s in steps[3:5]] == ["Reviewed q3.deck.html", "Reviewed the file"]
    assert wire["families"] == ["web", "decks", "files", "shell"]


@pytest.mark.parametrize(("label", "paused"), [("1792278833", True), ("", False), (None, False)])
def test_a_helpers_activity_says_whether_it_is_paused(label: str | None, paused: bool) -> None:
    labels = {"superchat.paused": label} if label is not None else {}
    helper = Conversation(
        id="h1",
        created_at=1,
        updated_at=1,
        root_conversation_id="chat",
        kind="sub_agent",
        parent_conversation_id="chat",
        live_status="running",
        labels=labels,
    )

    (activity,) = _activities_for_conversation(
        _Store([]),  # type: ignore[arg-type]
        helper,
        include_step_detail=False,
    )
    assert activity_to_dict(activity)["paused"] is paused
    turn = Conversation(id="chat", created_at=1, updated_at=1, root_conversation_id="chat")
    items = [_conversation_item(r, at) for at, r in enumerate(_turn(), start=1)]
    (row,) = _activities_for_conversation(
        _Store(items),  # type: ignore[arg-type]
        turn,
        include_step_detail=False,
    )
    assert "paused" not in activity_to_dict(row)
