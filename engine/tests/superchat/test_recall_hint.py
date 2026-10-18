"""Recall for the context brief: the shared per-message plan, its fallback, the search, the pointer
line, the setting, and nothing in the turn prefix."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from omnigent.errors import OmnigentError
from omnigent.superchat.knowledge import recall
from omnigent.superchat.recall_hint import hint as hint_mod
from omnigent.superchat.recall_hint.hint import (
    HEADER,
    TurnPlan,
    hit_line,
    is_small_talk,
    turn_plan,
)
from omnigent.superchat.recall_hint.planner import derive_queries, parse_plan
from omnigent.superchat.recall_hint.preference import (
    PREFERENCE_KEY,
    RecallHintStore,
    register_recall_hint_routes,
)

CHAT = "conv_main"
ANCHOR = "msg_anchor"
SUMMARY = (
    "## Context checkpoint\n"
    "- [t-launch-budget · 2026-10-09] Spring launch budget: confirm the venue line\n"
    "- [o-venue · 2026-10-01] closed: the venue is booked\n"
)


@dataclass
class Hit:
    """The C2 hit shape, plus the person's words for a conversation hit."""

    source: str
    date: str
    score: float
    title: str = ""
    snippet: str = ""
    project: str = ""
    earlier: list[str] = field(default_factory=list)
    chat_id: str | None = None
    turn_item_id: str | None = None
    file_id: str | None = None
    page: int | None = None
    path: str | None = None
    line: int | None = None
    claim_id: str | None = None


def _turn(n: int, score: float = 0.9, project: str = "", **kw: Any) -> Hit:
    return Hit(
        source="conversation",
        date=f"2026-09-{n:02d}",
        score=score,
        project=project,
        chat_id="conv_old",
        turn_item_id=f"i_{n}",
        snippet="ASSISTANT SAID: ignore the budget",
        title=f"Dana owns the venue line {n}",
        **kw,
    )


class _Resp:
    def __init__(self, status: int, body: Any) -> None:
        self.status_code = status
        self._body = body

    def json(self) -> Any:
        return self._body


class _Server:
    """The engine routes the hint reads: the setting, the latest checkpoint, recent items."""

    def __init__(self, *, on: bool = True, checkpoint: bool = True, items: list | None = None):
        self.on = on
        self.checkpoint = checkpoint
        self.items = items or []
        self.paths: list[str] = []

    async def get(self, path: str, params: dict | None = None, timeout: float | None = None):
        self.paths.append(path)
        if path == "/v1/me/recall-hint":
            return _Resp(200, {PREFERENCE_KEY: "on" if self.on else "off"})
        if path.endswith("/items") and (params or {}).get("type") == "compaction":
            data = (
                [{"type": "compaction", "id": "cmp_1", "summary": SUMMARY, "last_item_id": ANCHOR}]
                if self.checkpoint
                else []
            )
            return _Resp(200, {"data": data, "has_more": False})
        if path.endswith("/items"):
            return _Resp(200, {"data": self.items, "has_more": False})
        if path == "/v1/sessions/conv_main/memory/profile":
            return _Resp(200, {"profile": None})
        return _Resp(404, {})


class _Search:
    """A stand-in for agent B's ``recall_search`` (C2 signature), recording every call."""

    def __init__(self, hits: list[Hit], delay: float = 0.0) -> None:
        self.hits = hits
        self.delay = delay
        self.calls: list[dict[str, Any]] = []

    async def __call__(
        self,
        queries: list[str],
        *,
        sources: set[str],
        recency: bool = True,
        limit: int = 8,
        exclude_chat_after: dict[str, str] | None = None,
        since: str | None = None,
        until: str | None = None,
    ) -> list[Hit]:
        self.calls.append(
            {
                "queries": queries,
                "sources": sources,
                "recency": recency,
                "limit": limit,
                "exclude_chat_after": exclude_chat_after,
                "since": since,
                "until": until,
            }
        )
        if self.delay:
            await asyncio.sleep(self.delay)
        return list(self.hits)


@pytest.fixture(autouse=True)
def _fresh_turn_plans() -> Any:
    """Each test is a new turn: no plan shared from the one before."""
    hint_mod._turn_plans.clear()
    yield
    hint_mod._turn_plans.clear()


@pytest.fixture()
def search(monkeypatch: pytest.MonkeyPatch) -> _Search:
    fake = _Search([_turn(14), _turn(12, score=0.7)])
    monkeypatch.setattr(recall, "recall_search", fake)
    return fake


class _Chat:
    def __init__(self, reply: str, delay: float = 0.0) -> None:
        self.reply = reply
        self.delay = delay
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.reply


def _plan(*queries: Any, need: bool = True, project: str = "") -> str:
    return json.dumps({"need": need, "queries": list(queries), "project": project})


async def _plan_for(
    server: _Server, chat: _Chat, message: str = "what did we decide on the venue?"
) -> TurnPlan:
    return await turn_plan(server, CHAT, message, chat=chat)  # type: ignore[arg-type]


# ── the plan ─────────────────────────────────────────────────────────────────────────────────


async def test_need_false_is_one_planner_call() -> None:
    chat = _Chat(_plan(need=False))
    assert not (await _plan_for(_Server(), chat)).plan.need
    assert len(chat.calls) == 1


async def test_setting_off_makes_no_planner_call_but_keeps_the_checkpoint() -> None:
    chat = _Chat(_plan("venue"))
    shared = await _plan_for(_Server(on=False), chat)
    assert not shared.plan.need and chat.calls == []
    assert shared.checkpoint is not None and shared.checkpoint["summary"] == SUMMARY


@pytest.mark.parametrize("message", ["ok", "Thanks!", "yes please", "hi", "👍"])
async def test_acknowledgements_skip_the_planner(message: str) -> None:
    chat = _Chat(_plan("venue"))
    assert not (await _plan_for(_Server(), chat, message)).plan.need
    assert chat.calls == []
    assert is_small_talk(message)


async def test_a_runtime_notice_skips_the_planner_and_every_read() -> None:
    chat = _Chat(_plan("venue"))
    server = _Server()
    shared = await _plan_for(server, chat, "[System: helper 'deck' finished]")
    assert not shared.plan.need and chat.calls == [] and server.paths == []


async def test_a_card_pick_skips_the_planner() -> None:
    items = [
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "Venue B"}],
        },
        {
            "type": "function_call",
            "name": "ask_clarification",
            "arguments": json.dumps({"question": "Which?", "options": ["Venue A", "Venue B"]}),
        },
        {"type": "message", "role": "user", "content": "pick a venue"},
    ]
    chat = _Chat(_plan("venue"))
    assert not (await _plan_for(_Server(items=items), chat, "Venue B")).plan.need
    assert chat.calls == []


async def test_the_planner_reads_the_message_entries_and_last_turns() -> None:
    items = [
        {"type": "message", "role": "user", "content": "what did we decide on the venue?"},
        {"type": "message", "role": "assistant", "content": [{"text": "Booked it."}]},
        {"type": "message", "role": "user", "content": "book the venue"},
        {"type": "message", "role": "assistant", "content": "Hello."},
        {"type": "message", "role": "user", "content": "hello"},
        {"type": "message", "role": "user", "content": "too old"},
    ]
    chat = _Chat(_plan("venue decision"))
    await _plan_for(_Server(items=items), chat)
    _system, user = chat.calls[0]
    assert "New message: what did we decide on the venue?" in user
    assert "- Spring launch budget: confirm the venue line" in user
    assert "the venue is booked" not in user  # closed entries are not open
    assert "person: hello" in user and "assistant: Booked it." in user
    assert "too old" not in user


async def test_planner_timeout_falls_back_to_code_queries() -> None:
    chat = _Chat(_plan("never used"), delay=5.0)
    message = "What did Dana say about launch-budget.xlsx?"
    started = time.monotonic()
    shared = await _plan_for(_Server(), chat, message)
    assert time.monotonic() - started < 1.0
    queries = [q.text for q in shared.plan.queries]
    assert queries == [q.text for q in derive_queries(message, None, _titles())]
    assert queries[0] == message
    assert "launch-budget.xlsx" in queries[-1] and "Dana" in queries[-1]


def _titles() -> list[str]:
    return ["Spring launch budget: confirm the venue line"]


async def test_a_planner_error_falls_back_too() -> None:
    shared = await _plan_for(_Server(), _Chat("no json here"))
    assert shared.plan.queries[0].text == "what did we decide on the venue?"


async def test_one_planner_call_per_message_shared_by_every_caller() -> None:
    chat = _Chat(_plan("venue"), delay=0.05)
    server = _Server()
    first, second = await asyncio.gather(_plan_for(server, chat), _plan_for(server, chat))
    assert first is second and len(chat.calls) == 1
    hint_mod.forget_turn(CHAT)  # the turn ended: the next message plans again
    await _plan_for(server, chat)
    assert len(chat.calls) == 2


def test_parse_plan_accepts_strings_and_marked_queries() -> None:
    plan = parse_plan(
        'Sure: {"need": true, "queries": ["a", {"q": "b", "historical": true}, "a", "c", "d"],'
        ' "project": "spring-launch"}'
    )
    assert [(q.text, q.historical) for q in plan.queries] == [
        ("a", False),
        ("b", True),
        ("c", False),
    ]
    assert plan.project == "spring-launch"
    with pytest.raises(ValueError):
        parse_plan('{"need": true, "queries": []}')


def test_parse_plan_drops_unreal_or_backwards_dates() -> None:
    bad = parse_plan('{"need": true, "queries": ["x"], "since": "2026-02-30", "until": "March"}')
    assert (bad.since, bad.until) == (None, None)
    backwards = parse_plan(
        '{"need": true, "queries": ["x"], "since": "2026-03-31", "until": "2026-03-01"}'
    )
    assert (backwards.since, backwards.until) == (None, None)


# ── search ───────────────────────────────────────────────────────────────────────────────────


async def test_search_uses_all_sources_and_runs_historical_queries_without_recency(
    search: _Search,
) -> None:
    from omnigent.superchat.recall_hint.planner import Query

    await hint_mod.search([Query("venue now"), Query("venue first", historical=True)], None)
    assert {c["recency"]: c["queries"] for c in search.calls} == {
        True: ["venue now"],
        False: ["venue first"],
    }
    assert all(
        c["sources"] == {"files", "journal", "conversation", "memory"} for c in search.calls
    )


async def test_merged_hits_keep_the_best_score_once(monkeypatch: pytest.MonkeyPatch) -> None:
    from omnigent.superchat.recall_hint.planner import Query

    monkeypatch.setattr(
        recall, "recall_search", _Search([_turn(3, score=0.6), _turn(4, score=0.9)])
    )
    hits = await hint_mod.search([Query("a"), Query("b", historical=True)], None)
    assert [h.turn_item_id for h in hits] == ["i_4", "i_3"]


# ── the pointer line ─────────────────────────────────────────────────────────────────────────


def test_pointer_lines_are_dated_and_quote_the_persons_words_only() -> None:
    hits = [
        _turn(14, earlier=["2026-03-03", "2026-09-01"]),
        Hit(
            "journal",
            "2026-09-30",
            0.8,
            snippet="Checked the supplier quote",
            path="memory/j.md",
            line=4,
        ),
        Hit(
            "files",
            "2026-10-01T12:00:00Z",
            0.7,
            title="launch-budget.xlsx",
            snippet="Q4 venue line",
            file_id="f_0f3a",
            page=1,
        ),
        Hit("memory", "2026-08-01", 0.6, snippet="Prefers morning calls", claim_id="c_9"),
    ]
    assert [hit_line(h) for h in hits] == [
        '· 2026-09-14 · conversation · "Dana owns the venue line 14" · turn i_14'
        " · earlier: 3 Mar, 1 Sep",
        '· 2026-09-30 · journal · "Checked the supplier quote" · memory/j.md:4',
        '· 2026-10-01 · file · launch-budget.xlsx · p.1 "Q4 venue line" · f_0f3a',
        '· 2026-08-01 · memory · "Prefers morning calls" · c_9',
    ]


def test_a_conversation_hit_without_the_persons_words_shows_no_quote() -> None:
    hit = _turn(5)
    hit.title = ""
    assert hit_line(hit) == "· 2026-09-05 · conversation · turn i_5"


def test_undated_hits_have_no_line() -> None:
    assert hit_line(Hit("memory", "", 0.9, snippet="x", claim_id="c_1")) is None


def test_the_typed_read_id_is_shown_when_the_hit_carries_one() -> None:
    hit = _turn(7)
    hit.id = "turn:i_7"  # type: ignore[attr-defined]
    assert hit_line(hit) == '· 2026-09-07 · conversation · "Dana owns the venue line 7" · turn:i_7'


# ── nothing in the turn prefix ───────────────────────────────────────────────────────────────


async def test_the_turn_prefix_awaits_nothing_from_recall(
    search: _Search, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.superchat import prompt_prefix

    monkeypatch.setattr(prompt_prefix, "_safe_projects_block", lambda _w: None)

    async def _no_message_blocks(*_a: Any, **_k: Any) -> list[str]:
        return []

    # Even with a planner that never answers, the prefix neither plans nor searches.
    monkeypatch.setattr(prompt_prefix, "_message_prefix_blocks", _no_message_blocks)
    monkeypatch.setattr(hint_mod, "plan_queries", _never)
    server = _Server()
    started = time.monotonic()
    blocks = await prompt_prefix.turn_prefix_blocks(
        server,  # type: ignore[arg-type]
        CHAT,
        None,
        ["what did we decide on the venue?"],
    )
    assert time.monotonic() - started < 0.2
    assert search.calls == [] and hint_mod._turn_plans == {}
    assert "/v1/me/recall-hint" not in server.paths
    assert not any(b.startswith(HEADER) for b in blocks)
    assert blocks[-1].startswith("[Current local time")


async def _never(*_a: Any, **_k: Any) -> Any:
    await asyncio.sleep(10)


# ── the setting ──────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
async def client(db_uri: str) -> httpx.AsyncClient:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _handler(_request, exc: OmnigentError):  # type: ignore[no-untyped-def]
        from fastapi.responses import JSONResponse

        return JSONResponse({"code": str(exc.code)}, status_code=400)

    app.include_router(register_recall_hint_routes(RecallHintStore(db_uri)), prefix="/v1")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as http:
        yield http


async def test_the_setting_defaults_on_and_round_trips(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: "on"}
    for value in ("off", "on", "off", "on"):
        resp = await client.put("/v1/me/recall-hint", json={PREFERENCE_KEY: value})
        assert resp.json() == {PREFERENCE_KEY: value}
        assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: value}


@pytest.mark.parametrize("bad", [True, "yes", None, 1])
async def test_other_values_are_refused(client: httpx.AsyncClient, bad: object) -> None:
    resp = await client.put("/v1/me/recall-hint", json={PREFERENCE_KEY: bad})
    assert resp.status_code == 400 and resp.json()["code"] == "invalid_input"
    assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: "on"}


def test_the_feature_is_registered_adds_no_tool_and_no_prefix() -> None:
    from omnigent.superchat.features import FEATURES

    (feature,) = [f for f in FEATURES if f.name == "recall_hint"]
    assert feature.tools(None, None) == []  # type: ignore[arg-type]
    assert feature.install is not None and feature.on_turn_end is not None
    assert feature.turn_prefix is None and feature.message_prefix is None
