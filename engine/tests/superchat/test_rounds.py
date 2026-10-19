"""A Round is recorded and folded (ADR 0029): the fold over the recorded streams and its cases,
the Round rule, and the writers from a relayed stream to the ``round_events`` table."""

from __future__ import annotations

import asyncio
import copy
import json
import random
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from omnigent.context.labels import (
    ARTIFACT_CHAT_LABEL_KEY,
    CONTEXT_MODE_LABEL,
    ROUND_LABEL_KEY,
    SCHEDULED_FIRE_LABEL_KEY,
    SCHEDULED_HELPER_LABEL_KEY,
    SUPERSIDE_CHAT_MODE_VALUE,
)
from omnigent.superchat.rounds import record
from omnigent.superchat.rounds.fold import fold
from omnigent.superchat.rounds.store import SqlAlchemyRoundStore

ROUNDS = Path(__file__).parent / "rounds"
RANK = {"idle": 0, "running": 1, "done": 2, "stopped": 2}


def load(name: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (ROUNDS / f"{name}.jsonl").read_text().splitlines()]


class S:
    """A Round's event stream with a clock that moves one second per event."""

    def __init__(self, rid: str = "r1") -> None:
        self.ev: list[dict[str, Any]] = []
        self.t = 0.0
        self.rid = rid
        self.n = 0

    def __call__(self, kind: str, actor: str = "assistant", dt: float = 1.0, **body: Any) -> S:
        self.t = round(self.t + dt, 3)
        self.ev.append({"t": self.t, "kind": kind, "round_id": self.rid, "actor": actor, **body})
        return self

    def open(self) -> S:
        return self("round.opened", "person", text="x")("turn.started")

    def started(self, tool: str, helper: str | None = None) -> S:
        self.n += 1
        return self("tool.started", **_by(helper), call_id=f"c{self.n}", name=tool)

    def inp(self, tool: str, helper: str | None = None, size: int = 2048) -> S:
        return self("tool.input", **_by(helper), call_id=f"c{self.n}", name=tool, bytes=size)

    def result(self, tool: str, helper: str | None = None, ok: bool = True, dt: float = 1.0) -> S:
        return self("tool.result", **_by(helper), dt=dt, call_id=f"c{self.n}", name=tool, ok=ok)

    def save(self, name: str, helper: str | None = None, dt: float = 1.0) -> S:
        self.started("artifact_save", helper).result("artifact_save", helper, dt=dt)
        return self("file.saved", **_by(helper), dt=0.0, name=name, file_kind="deck")

    def spawn(self, hid: str, title: str) -> S:
        self.started("start_helper")("helper.started", helper_id=hid, title=title)
        return self.result("start_helper")

    def words(self, text: str, helper: str | None = None) -> S:
        return self("words", **_by(helper), text=text)

    def end(self) -> S:
        return self("turn.ended", status="done")

    def wake(self) -> S:
        return self("turn.started")

    def fin(self, hid: str, status: str = "done", result: str = "ok") -> S:
        return self("helper.finished", "helper", helper_id=hid, status=status, result=result)

    def stop(self) -> S:
        return self("stop.requested", "person", scope="round")


def _by(helper: str | None) -> dict[str, str]:
    """Who an event is from: the Assistant, or the Helper with that id."""
    return {"actor": "helper", "helper_id": helper} if helper else {"actor": "assistant"}


def cuts_ok(events: list[dict[str, Any]], rid: str = "r1") -> dict[str, Any]:
    """Fold every cut: same output for the same input, status never goes down, settlement never
    moves, files never shrink, a settled Round shows nothing live and no running Helper."""
    prev: dict[str, Any] | None = None
    for i in range(len(events) + 1):
        v = fold(events[:i], rid)
        assert v == fold(events[:i], rid)
        if prev is not None:
            assert RANK[v["status"]] >= RANK[prev["status"]], (i, prev["status"], v["status"])
            if prev["settled_at"] is not None:
                assert (v["settled_at"], v["status"]) == (prev["settled_at"], prev["status"]), i
            assert len(v["files"]) >= len(prev["files"]), i
        if v["settled_at"] is not None:
            assert v["now"] is None, (i, v["now"])
            assert not any(h["status"] == "running" for h in v["helpers"].values()), i
        prev = v
    assert prev is not None
    return prev


# ------------------------------------------------------------------ the recorded streams
@pytest.mark.parametrize(
    ("name", "status", "files", "helper"),
    [
        ("claude_A_normal", "done", ["uruguay"], "done"),
        ("pi_A_normal", "done", ["uruguay"], "done"),
        ("claude_B_stop", "stopped", [], "stopped"),
        ("pi_B_stop", "stopped", [], "stopped"),
    ],
)
def test_recorded_stream_folds_on_every_cut(
    name: str, status: str, files: list[str], helper: str, db_uri: str
) -> None:
    events = load(name)
    v = cuts_ok(events)
    assert v["status"] == status
    assert [f["name"] for f in v["files"]] == files
    assert v["helpers"]["h1"]["status"] == helper
    assert v["words"] and v["words"][0].startswith("I")
    if status == "stopped":
        # The executor said the stopped Helper was done (Claude); the Round says stopped.
        title = v["helpers"]["h1"]["title"]
        assert v["stop_line"] == f"Stopped. '{title}' was still working; nothing was saved."
        follow_up = fold(events, "r2")
        assert follow_up["status"] == "done" and follow_up["helpers"] == {}
    # Reconnecting mid-turn: the first turn's streamed words are in the view before it ends.
    first_end = next(i for i, e in enumerate(events) if e["kind"] == "turn.ended")
    assert "Uruguay" in fold(events[:first_end], "r1")["live_words"]
    # Written through the Recorder into a real table and read back, each Round folds the same.
    store = SqlAlchemyRoundStore(db_uri)
    recorder = record.Recorder(store)
    ids = {"r1": "1" * 32, "r2": "2" * 32}

    async def write() -> None:
        for e in events:
            body = {k: v for k, v in e.items() if k not in ("t", "round_id", "kind", "actor")}
            recorder.record(ids[e["round_id"]], "c" * 32, e["kind"], e["actor"], **body)
        await recorder.idle()

    asyncio.run(write())
    for rid, stored_id in ids.items():
        want, got = fold(events, rid), fold(store.events(stored_id), stored_id)
        for key in ("status", "stop_line", "files", "chips", "words", "checklist"):
            assert got[key] == want[key], (rid, key)
        assert {h: x["status"] for h, x in got["helpers"].items()} == {
            h: x["status"] for h, x in want["helpers"].items()
        }


# ------------------------------------------------------------------ the fold's cases
def _two_helpers() -> S:
    s = S().open().spawn("h1", "A").spawn("h2", "B").words("Working on both.").end()
    return s.started("artifact_save", "h2").inp("artifact_save", "h2", 1024)


def _full_run() -> S:
    s = S().open().words("ok").spawn("h1", "Deck").end()
    s.save("d", "h1").fin("h1").wake().words("Ready.")
    s.started("suggest_follow_ups").result("suggest_follow_ups")("chips", items=["a"])
    return s.end()


def _stop_race() -> tuple[dict[str, Any], dict[str, Any]]:
    s = S().open().spawn("h1", "Deck").end()
    s.started("artifact_save", "h1").stop()
    before = fold(s.ev, "r1")
    s("tool.result", "helper", dt=0.01, helper_id="h1", call_id=f"c{s.n}", ok=True)
    s("file.saved", "helper", dt=0.0, helper_id="h1", name="d").fin("h1", result="saved d")
    return before, cuts_ok(s.ev)


def _redelivered(kind: str, after: str) -> dict[str, Any]:
    ev = _full_run().ev
    i = next(i for i, e in enumerate(ev) if e["kind"] == kind)
    j = next(
        j for j, e in enumerate(ev) if j > i and e["kind"] == after and e["actor"] != "person"
    )
    return fold([*ev[: j + 1], dict(ev[i], t=ev[j]["t"]), *ev[j + 1 :]], "r1")


def _late_events_change_nothing() -> list[str]:
    base = S().open().spawn("h1", "Deck").end().stop()
    v0 = fold(base.ev, "r1")
    late: list[dict[str, Any]] = [
        {"kind": "tool.started", "actor": "helper", "helper_id": "h1", "call_id": "x"},
        {"kind": "helper.started", "actor": "assistant", "helper_id": "h9", "title": "Late"},
        {"kind": "round.opened", "actor": "person", "text": "x"},
        {"kind": "turn.started", "actor": "assistant"},
        {"kind": "file.saved", "actor": "helper", "helper_id": "h1", "name": "late"},
        {"kind": "checklist.created", "actor": "assistant", "item_id": "1", "subject": "a"},
    ]
    bad = []
    for e in late:
        v = fold([*base.ev, {"t": base.t + 1, "round_id": "r1", **e}], "r1")
        same = {k: x for k, x in v.items() if k != "after_settle"} == {
            k: x for k, x in v0.items() if k != "after_settle"
        }
        if not same or len(v["after_settle"]) != len(v0["after_settle"]) + 1:
            bad.append(e["kind"])
    return bad


def _view_does_not_alias_input() -> bool:
    s = S().open()("checklist.created", item_id="1", subject="a").end().stop()
    s("file.saved", "helper", helper_id="h1", name="late")
    snapshot = copy.deepcopy(s.ev)
    v = fold(s.ev, "r1")
    v["checklist"].append("mutated")
    for e in v["after_settle"]:
        e["kind"] = "mutated"
    return s.ev == snapshot


CASES: list[tuple[str, Callable[[], Any], Callable[[Any], bool]]] = [
    ("empty", lambda: fold([]), lambda v: v["status"] == "idle" and v["elapsed"] == 0),
    (
        "direct build settles done",
        lambda: cuts_ok(S().open().save("d").words("Here.").end().ev),
        lambda v: v["status"] == "done" and v["words"] == ["Here."] and len(v["files"]) == 1,
    ),
    (
        "words only from the Assistant, chips from their event",
        lambda: fold(S().open().words("hi").words("helper", "h1")("chips", items=["a"]).end().ev),
        lambda v: v["words"] == ["hi"] and v["chips"] == ["a"] and v["status"] == "done",
    ),
    (
        "a re-save replaces the file",
        lambda: fold(S().open().save("d").save("d").end().ev),
        lambda v: [f["name"] for f in v["files"]] == ["d"],
    ),
    (
        "two Helpers, one wake",
        lambda: cuts_ok(_two_helpers().fin("h1").fin("h2").wake().words("Both.").end().ev),
        lambda v: v["status"] == "done" and v["words"][-1] == "Both.",
    ),
    (
        "two Helpers, the second finishes during the first wake",
        lambda: fold(_two_helpers().fin("h1").wake().fin("h2").end().ev),
        lambda v: v["status"] == "running",
    ),
    (
        "a second-generation Helper is waited for",
        lambda: fold(S().open().spawn("h1", "R").end().fin("h1").wake().spawn("h2", "D").end().ev),
        lambda v: v["status"] == "running",
    ),
    (
        "a failed Helper waits for its wake, then done and failed",
        lambda: cuts_ok(
            S().open().spawn("h1", "D").end().fin("h1", "failed", "boom").wake().end().ev
        ),
        lambda v: (
            v["status"] == "done" and v["failed_helper"] and v["helpers"]["h1"]["result"] == "boom"
        ),
    ),
    (
        "a Helper result is not consumed before its wake",
        lambda: fold(S().open().spawn("h1", "D").end().fin("h1").ev),
        lambda v: v["status"] == "running" and not v["failed_helper"],
    ),
    (
        "helper.finished before helper.started",
        lambda: fold(
            S()
            .open()
            .fin("h1")("helper.started", dt=0.01, helper_id="h1", title="D")
            .end()
            .wake()
            .end()
            .ev
        ),
        lambda v: v["status"] == "done" and v["helpers"]["h1"]["status"] == "done",
    ),
    (
        "Stop races a save 10 ms after it",
        _stop_race,
        lambda r: (
            r[1]["status"] == "stopped"
            and r[1]["settled_at"] == r[0]["settled_at"]
            and r[1]["files"] == []
            and r[1]["trail"] == r[0]["trail"]
            and r[1]["helpers"]["h1"]["result"] == "saved d"
        ),
    ),
    (
        "Stop while the Assistant writes keeps only the words before it",
        lambda: cuts_ok(
            S().open().words("I'll make").started("start_helper").stop().words(" a deck").end().ev
        ),
        lambda v: v["stop_line"] == "Stopped. Nothing was saved." and v["words"] == ["I'll make"],
    ),
    (
        "a stopped Round shows nothing live",
        lambda: fold(S().open().spawn("h1", "D").end().started("artifact_save", "h1").stop().ev),
        lambda v: v["now"] is None,
    ),
    (
        "two Stops are one",
        lambda: (
            fold(S().open().spawn("h1", "D").end().stop().ev),
            fold(S().open().spawn("h1", "D").end().stop().stop().ev),
        ),
        lambda r: (
            (r[0]["settled_at"], r[0]["stop_line"]) == (r[1]["settled_at"], r[1]["stop_line"])
        ),
    ),
    (
        "the Stop line never says nothing was saved when a file was",
        lambda: fold(S().open().spawn("h1", "D").end().save("d", "h1").stop().ev),
        lambda v: v["stop_line"] == "Stopped. 'D' was still working; 'd' was saved.",
    ),
    (
        "a reopen after Stop never runs again",
        lambda: fold(S().open().spawn("h1", "D").end().stop()("round.opened", "person").ev),
        lambda v: v["status"] == "stopped",
    ),
    (
        "Stop before the Round opens",
        lambda: fold(S().stop()("round.opened", "person").ev),
        lambda v: not (v["status"] == "running" and v["settled_at"] is not None),
    ),
    ("events after settlement change nothing", _late_events_change_nothing, lambda bad: bad == []),
    (
        "a result without a start, and input after a result",
        lambda: fold(
            S()
            .open()
            .result("deck_check")
            .started("artifact_save")
            .result("artifact_save")
            .inp("artifact_save")
            .ev
        ),
        lambda v: v["now"] is None and len(v["trail"]) == 2,
    ),
    (
        "the Assistant's tool does not take a Helper's live line",
        lambda: fold(
            _two_helpers()
            .fin("h1")
            .wake()
            .started("suggest_follow_ups")
            .result("suggest_follow_ups")
            .end()
            .ev
        ),
        lambda v: (
            v["now"] is not None and v["now"]["helper_id"] == "h2" and v["now"]["bytes"] == 1024
        ),
    ),
    (
        "a word after its turn ended is kept",
        lambda: fold(S().open().spawn("h1", "D").words("Building.").end().words(" (late)").ev),
        lambda v: v["status"] == "running" and v["words"] == ["Building. (late)"],
    ),
    (
        "every event delivered twice",
        lambda: (
            fold(_full_run().ev),
            fold(
                [
                    x
                    for e in _full_run().ev
                    for x in ([e, dict(e)] if e["kind"] != "words" else [e])
                ]
            ),
        ),
        lambda r: all(
            r[0][k] == r[1][k]
            for k in ("status", "settled_at", "files", "chips", "helpers", "words")
        ),
    ),
    (
        "helper.started redelivered after its finish",
        lambda: _redelivered("helper.started", "helper.finished"),
        lambda v: v["status"] == "done" and v["helpers"]["h1"]["status"] == "done",
    ),
    (
        "helper.finished redelivered during the wake",
        lambda: _redelivered("helper.finished", "turn.started"),
        lambda v: v["status"] == "done",
    ),
    (
        "Rounds are folded apart",
        lambda: (S("r1").open().spawn("h1", "D").end().ev, S("r2").open().words("other").end().ev),
        lambda r: fold(sorted(r[0] + r[1], key=lambda e: e["t"]), "r1") == fold(r[0], "r1"),
    ),
    ("the view never aliases its events", _view_does_not_alias_input, lambda same: same),
    (
        "a hidden Round is a system run",
        lambda: fold(S()("round.opened", "system", text="notes")("turn.started").end().ev),
        lambda v: v["hidden"] and v["status"] == "done",
    ),
    (
        "the checklist is the model's words, beside the facts",
        lambda: fold(
            S()
            .open()("checklist.created", item_id="1", subject="Deck", active_form="Building")(
                "checklist.created", item_id="2", subject="Page"
            )("checklist.updated", item_id="1", status="completed")(
                "checklist.updated", item_id="2", status="deleted"
            )
            .end()
            .ev
        ),
        lambda v: (
            v["checklist"]
            == [{"id": "1", "subject": "Deck", "active_form": "Building", "status": "completed"}]
            and v["status"] == "done"
        ),
    ),
]


@pytest.mark.parametrize(("build", "check"), [pytest.param(b, c, id=n) for n, b, c in CASES])
def test_fold_case(build: Callable[[], Any], check: Callable[[Any], bool]) -> None:
    assert check(build())


KINDS = [
    "words",
    "tool.started",
    "tool.input",
    "tool.result",
    "file.saved",
    "helper.started",
    "helper.finished",
    "turn.started",
    "turn.ended",
    "stop.requested",
    "checklist.created",
    "round.opened",
]


def _random_event(rng: random.Random, t: float) -> dict[str, Any]:
    kind = rng.choice(KINDS)
    hid = rng.choice(["h1", "h2"])
    actor = rng.choice(["assistant", "helper"])
    e: dict[str, Any] = {"t": t, "kind": kind, "round_id": rng.choice(["r1", "r1", "r1", "r2"])}
    e["actor"] = actor
    if actor == "helper":
        e["helper_id"] = hid
    if kind == "words":
        e["text"] = rng.choice(["a", "b "])
    elif kind.startswith("tool."):
        e.update(
            call_id=rng.choice(["c1", "c2"]), name="artifact_save", bytes=rng.randint(0, 9000)
        )
    elif kind == "file.saved":
        e["name"] = rng.choice(["d", "p"])
    elif kind in ("helper.started", "helper.finished"):
        e.update(helper_id=hid, title="T", status=rng.choice(["done", "failed", "stopped"]))
    elif kind == "checklist.created":
        e.update(item_id="1", subject="x")
    return e


def test_random_streams_keep_the_invariants() -> None:
    """300 seeded streams of any kind, either actor, either Round, in odd orders."""
    for seed in range(300):
        rng = random.Random(seed)
        ev = [{"t": 0.0, "kind": "round.opened", "round_id": "r1", "actor": "person"}]
        ev += [_random_event(rng, round(0.1 * (i + 1), 2)) for i in range(rng.randint(1, 40))]
        cuts_ok(ev)


# ------------------------------------------------------------------ the Round rule
SUPER = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
IN_ROUND = {**SUPER, ROUND_LABEL_KEY: "r0"}


@pytest.mark.parametrize(
    ("labels", "helper", "by_person", "running", "helper_round", "expected"),
    [
        pytest.param({}, False, True, False, None, None, id="not a Superchat session"),
        pytest.param(SUPER, False, True, False, None, ("m1", True, "person"), id="person opens"),
        pytest.param(IN_ROUND, False, True, False, None, ("m1", True, "person"), id="next ask"),
        pytest.param(IN_ROUND, False, True, True, None, ("r0", False, "person"), id="steer joins"),
        pytest.param(IN_ROUND, False, False, False, "rh", ("rh", False, "person"), id="wake"),
        pytest.param(IN_ROUND, False, False, True, None, ("r0", False, "person"), id="notice"),
        pytest.param(SUPER, False, False, False, None, None, id="notice outside a Round"),
        pytest.param(
            IN_ROUND, True, True, False, None, ("r0", False, "person"), id="Helper brief"
        ),
        pytest.param(SUPER, True, True, False, None, None, id="Helper outside a Round"),
        pytest.param(
            {**SUPER, SCHEDULED_FIRE_LABEL_KEY: "s1"},
            False,
            True,
            False,
            None,
            ("m1", True, "system"),
            id="scheduled run is hidden",
        ),
    ],
)
def test_assign_round(
    labels: dict[str, str],
    helper: bool,
    by_person: bool,
    running: bool,
    helper_round: str | None,
    expected: tuple[str, bool, str] | None,
) -> None:
    got = record.assign_round(
        item_id="m1",
        labels=labels,
        helper=helper,
        by_person=by_person,
        turn_running=running,
        helper_round=helper_round,
    )
    assert (got and (got.round_id, got.opened, got.actor)) == expected


# ------------------------------------------------------------------ the writers
class _Conversations:
    """The two calls the writers make on the conversation store."""

    def __init__(self, *rows: types.SimpleNamespace) -> None:
        self.rows = {row.id: row for row in rows}

    def get_conversation(self, conversation_id: str) -> types.SimpleNamespace | None:
        return self.rows.get(conversation_id)

    def set_labels(self, conversation_id: str, labels: dict[str, str]) -> None:
        self.rows[conversation_id].labels.update(labels)


def _row(cid: str, labels: dict[str, str], parent: str | None = None) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        id=cid,
        root_conversation_id=parent or cid,
        parent_conversation_id=parent,
        kind="sub_agent" if parent else "default",
        labels=dict(labels),
        title="Deck",
        workspace="/workspace",
    )


def _done(item: dict[str, Any]) -> dict[str, Any]:
    return {"type": "response.output_item.done", "item": item}


def test_a_round_is_written_from_the_message_the_relay_and_the_save(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A person's message opens the Round, its Helper inherits it, the relayed streams of both
    become events in order, the save and the Stop are recorded, and the fold reads them back.
    The Helper the Stop interrupts reads stopped though its executor called the turn done, and
    its late wake is a stopped Round's."""
    store = SqlAlchemyRoundStore(db_uri)
    monkeypatch.setattr(record, "RECORDER", record.Recorder(store))
    root = "a" * 32
    item = "b" * 32
    helper_id = "c" * 32
    convs = _Conversations(_row(root, SUPER))
    msg = {"role": "user", "content": [{"type": "input_text", "text": "Make a deck."}]}
    assistant = record.RelayRound(root, convs)

    async def run() -> None:
        await record.note_message(convs, convs.rows[root], item, msg, None, turn_running=False)
        await assistant.observe({"type": "response.in_progress"})
        for delta in ("On ", "it."):
            await assistant.observe({"type": "response.output_text.delta", "delta": delta})
        await assistant.observe(
            {"type": record.TOOL_INPUT_DELTA, "call_id": "t1", "name": "start_helper", "delta": ""}
        )
        inherited = record.helper_labels(convs.rows[root].labels, SUPER)
        child = _row(helper_id, {**SUPER, **inherited}, root)
        convs.rows[helper_id] = child
        record.helper_created(child)
        call = {"type": "function_call", "call_id": "t1", "name": "start_helper"}
        await assistant.observe(_done({**call, "arguments": '{"title": "Deck"}'}))
        out = {"type": "function_call_output", "call_id": "t1", "output": '{"started": true}'}
        await assistant.observe(_done(out))
        await assistant.observe({"type": "response.completed"})
        helper = record.RelayRound(helper_id, convs)
        await helper.observe({"type": "response.in_progress"})
        await helper.observe({"type": "response.output_text.delta", "delta": "Saved the deck."})
        record.file_saved(
            child, types.SimpleNamespace(name="deck", kind="html", id="v1", version=1)
        )
        stopped = await record.stop_round(convs.rows[root], [child])
        assert stopped == record.Stopped(
            item, "Stopped. 'Deck' was still working; 'deck' was saved."
        )
        await helper.observe({"type": "response.completed"}, stopped=True)
        wake = {"role": "user", "is_system_notice": True, "content": []}
        notice = {"helper_id": helper_id}
        assert await record.stopped_wake(convs, convs.rows[root], wake, notice)
        assert not await record.stopped_wake(convs, convs.rows[root], msg, None)
        assert record.RECORDER is not None
        await record.RECORDER.idle()

    asyncio.run(run())
    events = store.events(item)
    assert [(e["kind"], e["actor"]) for e in events] == [
        ("round.opened", "person"),
        ("turn.started", "assistant"),
        ("words", "assistant"),
        ("tool.started", "assistant"),
        ("helper.started", "assistant"),
        ("tool.called", "assistant"),
        ("tool.result", "assistant"),
        ("turn.ended", "assistant"),
        ("turn.started", "helper"),
        ("words", "helper"),
        ("file.saved", "helper"),
        ("stop.requested", "person"),
        ("turn.ended", "helper"),
        ("helper.finished", "helper"),
    ]
    assert [e["seq"] for e in events] == list(range(1, 15))
    assert events[2]["text"] == "On it." and events[5]["digest"] == "title=Deck"
    assert events[13]["status"] == "stopped" and events[13]["helper_id"] == helper_id
    view = fold(events, item)
    assert view["status"] == "stopped" and view["ask"] == "Make a deck."
    assert [f["name"] for f in view["files"]] == ["deck"]
    assert convs.rows[helper_id].labels[ROUND_LABEL_KEY] == item
    # A scheduled Helper and a file's studio are not in their parent's Round.
    assert record.helper_labels(IN_ROUND, {SCHEDULED_HELPER_LABEL_KEY: "s1"}) == {}
    assert record.helper_labels(IN_ROUND, {ARTIFACT_CHAT_LABEL_KEY: "g1"}) == {}
