"""The per-turn recall hint: planner, fallback, block, caps, floor, likely Project, setting."""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from omnigent.errors import OmnigentError
from omnigent.runner.knowledge import recall
from omnigent.superchat.recall_hint import hint as hint_mod
from omnigent.superchat.recall_hint.hint import (
    FOOTER,
    HEADER,
    HINT_CAP_SECONDS,
    MAX_LINES,
    MAX_TOKENS,
    count_tokens,
    is_small_talk,
    recall_hint_block,
    render_block,
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


async def _hint(server: _Server, chat: _Chat, message: str = "what did we decide on the venue?"):
    return await recall_hint_block(server, CHAT, None, [message], chat=chat)  # type: ignore[arg-type]


# ── planner, fallback, setting ───────────────────────────────────────────────────────────────


async def test_need_false_runs_no_search_and_adds_no_block(search: _Search) -> None:
    chat = _Chat(_plan(need=False))
    assert await _hint(_Server(), chat) is None
    assert len(chat.calls) == 1
    assert search.calls == []


async def test_setting_off_makes_no_planner_call_and_no_search(search: _Search) -> None:
    chat = _Chat(_plan("venue"))
    assert await _hint(_Server(on=False), chat) is None
    assert chat.calls == [] and search.calls == []


@pytest.mark.parametrize("message", ["ok", "Thanks!", "yes please", "hi", "👍"])
async def test_acknowledgements_skip_the_planner(search: _Search, message: str) -> None:
    chat = _Chat(_plan("venue"))
    assert await _hint(_Server(), chat, message) is None
    assert chat.calls == [] and search.calls == []
    assert is_small_talk(message)


async def test_a_card_pick_skips_the_planner(search: _Search) -> None:
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
    assert await _hint(_Server(items=items), chat, "Venue B") is None
    assert chat.calls == [] and search.calls == []


async def test_the_planner_reads_the_message_project_entries_and_last_turns(
    search: _Search,
) -> None:
    items = [
        {"type": "message", "role": "user", "content": "what did we decide on the venue?"},
        {"type": "message", "role": "assistant", "content": [{"text": "Booked it."}]},
        {"type": "message", "role": "user", "content": "book the venue"},
        {"type": "message", "role": "assistant", "content": "Hello."},
        {"type": "message", "role": "user", "content": "hello"},
        {"type": "message", "role": "user", "content": "too old"},
    ]
    chat = _Chat(_plan("venue decision"))
    await _hint(_Server(items=items), chat)
    _system, user = chat.calls[0]
    assert "New message: what did we decide on the venue?" in user
    assert "- Spring launch budget: confirm the venue line" in user
    assert "the venue is booked" not in user  # closed entries are not open
    assert "person: hello" in user and "assistant: Booked it." in user
    assert "too old" not in user


async def test_planner_timeout_falls_back_to_code_queries_within_the_cap(
    search: _Search,
) -> None:
    chat = _Chat(_plan("never used"), delay=5.0)
    message = "What did Dana say about launch-budget.xlsx?"
    started = time.monotonic()
    block = await _hint(_Server(), chat, message)
    assert time.monotonic() - started < HINT_CAP_SECONDS
    assert block is not None
    (call,) = search.calls
    assert call["queries"] == [q.text for q in derive_queries(message, None, _titles())]
    assert call["queries"][0] == message
    assert "launch-budget.xlsx" in call["queries"][-1] and "Dana" in call["queries"][-1]


def _titles() -> list[str]:
    return ["Spring launch budget: confirm the venue line"]


async def test_a_planner_error_falls_back_too(search: _Search) -> None:
    assert await _hint(_Server(), _Chat("no json here")) is not None
    assert search.calls[0]["queries"][0] == "what did we decide on the venue?"


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


# ── search ───────────────────────────────────────────────────────────────────────────────────


async def test_search_uses_all_sources_and_leaves_the_current_epoch_out(search: _Search) -> None:
    await _hint(_Server(), _Chat(_plan("venue")))
    (call,) = search.calls
    assert call["sources"] == {"files", "journal", "conversation", "memory"}
    assert call["exclude_chat_after"] == {CHAT: ANCHOR}
    assert call["recency"] is True


async def test_without_a_checkpoint_this_chats_own_turns_are_left_out(search: _Search) -> None:
    await _hint(_Server(checkpoint=False), _Chat(_plan("venue")))
    assert search.calls[0]["exclude_chat_after"] == {CHAT: ""}  # recall leaves the chat out


async def test_historical_turns_recency_off_for_that_query_only(search: _Search) -> None:
    chat = _Chat(_plan("venue now", {"q": "venue first discussed", "historical": True}))
    await _hint(_Server(), chat)
    by_recency = {c["recency"]: c["queries"] for c in search.calls}
    assert by_recency == {True: ["venue now"], False: ["venue first discussed"]}


async def test_a_month_in_the_message_bounds_the_search_to_its_dates(search: _Search) -> None:
    reply = json.dumps(
        {
            "need": True,
            "queries": [{"q": "decision", "historical": True}],
            "since": "2026-03-01",
            "until": "2026-03-31",
        }
    )
    chat = _Chat(reply)
    await _hint(_Server(), chat, "what did we decide in March")
    assert re.search(r"^Today: \d{4}-\d{2}-\d{2}$", chat.calls[0][1], re.M)
    (call,) = search.calls
    assert (call["since"], call["until"]) == ("2026-03-01", "2026-03-31")
    # A date that is not real, or a range the wrong way round, is dropped.
    bad = parse_plan('{"need": true, "queries": ["x"], "since": "2026-02-30", "until": "March"}')
    assert (bad.since, bad.until) == (None, None)
    backwards = parse_plan(
        '{"need": true, "queries": ["x"], "since": "2026-03-31", "until": "2026-03-01"}'
    )
    assert (backwards.since, backwards.until) == (None, None)


async def test_merged_hits_keep_the_best_score_once(monkeypatch: pytest.MonkeyPatch) -> None:
    from omnigent.superchat.recall_hint.planner import Query

    monkeypatch.setattr(
        recall, "recall_search", _Search([_turn(3, score=0.6), _turn(4, score=0.9)])
    )
    hits = await hint_mod.search([Query("a"), Query("b", historical=True)], None)
    assert [h.turn_item_id for h in hits] == ["i_4", "i_3"]


# ── the block ────────────────────────────────────────────────────────────────────────────────


def test_block_format_dates_and_person_words_only() -> None:
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
    block = render_block(hits)
    assert block is not None
    lines = block.split("\n")
    assert lines[0] == HEADER and lines[-1] == FOOTER
    assert "the working list above is current" in HEADER
    assert lines[1:-1] == [
        '· 2026-09-14 · conversation · "Dana owns the venue line 14" · turn i_14'
        " · earlier: 3 Mar, 1 Sep",
        '· 2026-09-30 · journal · "Checked the supplier quote" · memory/j.md:4',
        '· 2026-10-01 · file · launch-budget.xlsx · p.1 "Q4 venue line" · f_0f3a',
        '· 2026-08-01 · memory · "Prefers morning calls" · c_9',
    ]
    assert "ASSISTANT SAID" not in block


def test_a_conversation_hit_without_the_persons_words_shows_no_quote() -> None:
    hit = _turn(5)
    hit.title = ""
    block = render_block([hit])
    assert block is not None and "ASSISTANT" not in block
    assert "· 2026-09-05 · conversation · turn i_5" in block


def test_undated_hits_are_not_shown() -> None:
    assert render_block([Hit("memory", "", 0.9, snippet="x", claim_id="c_1")]) is None


def test_at_most_eight_lines() -> None:
    block = render_block([_turn(n) for n in range(1, 13)])
    assert block is not None and len(block.split("\n")) == MAX_LINES


async def test_fifty_turns_each_add_at_most_300_tokens(search: _Search) -> None:
    long = "venue budget supplier quote " * 40
    for n in range(50):
        search.hits = [
            Hit(
                "conversation" if i % 2 else "files",
                f"2026-09-{(n + i) % 28 + 1:02d}",
                0.95 - i * 0.01,
                title=f"{long[: 40 + n]}.xlsx",
                snippet=long,
                project=f"p{i % 3}",
                earlier=["2026-01-02", "2026-02-03", "2026-03-04", "2026-04-05"],
                chat_id="conv_old",
                turn_item_id=f"i_{n}_{i}_{'x' * 30}",
                file_id=f"f_{n}_{i}",
                page=i,
            )
            for i in range(8)
        ]
        block = await _hint(_Server(), _Chat(_plan(f"venue {n}")))
        assert block is not None
        assert count_tokens(block) <= MAX_TOKENS
        assert len(block.split("\n")) <= MAX_LINES


async def test_below_the_floor_there_is_no_block(search: _Search) -> None:
    search.hits = [_turn(1, score=hint_mod.SCORE_FLOOR - 0.01)]
    assert await _hint(_Server(), _Chat(_plan("venue"))) is None
    search.hits = [_turn(1, score=hint_mod.SCORE_FLOOR)]
    assert await _hint(_Server(), _Chat(_plan("venue"))) is not None


def test_likely_project_only_when_hits_cluster_outside_the_open_project() -> None:
    clustered = [
        _turn(1, project="spring-launch"),
        _turn(2, project="spring-launch"),
        _turn(3, project="spring-launch"),
        _turn(4, project="taxes"),
    ]
    block = render_block(clustered, open_project="taxes")
    assert block is not None
    assert "· likely Project: spring-launch (3 of 4 hits)" in block.split("\n")
    assert block.count("likely Project") == 1
    # The open Project is never suggested.
    assert "likely Project" not in (render_block(clustered, open_project="spring-launch") or "")
    # No cluster: two of four is not more than half, one hit is not a cluster.
    split = [_turn(1, project="a"), _turn(2, project="a"), _turn(3, project="b"), _turn(4)]
    assert "likely Project" not in (render_block(split) or "")
    assert "likely Project" not in (render_block([_turn(1, project="a")]) or "")
    # The planner's guess is shown only with at least two hits behind it.
    assert "likely Project: a (2 of 4 hits)" in (render_block(split, guess="a") or "")
    assert "likely Project" not in (render_block(split, guess="b") or "")


# ── the caps and the turn ────────────────────────────────────────────────────────────────────


async def test_over_the_whole_cap_there_is_no_block_and_the_turn_proceeds(
    search: _Search, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.superchat import prompt_prefix

    monkeypatch.setattr(prompt_prefix, "_safe_projects_block", lambda _w: None)
    search.delay = 5.0
    server = _Server()
    started = time.monotonic()
    blocks = await prompt_prefix.turn_prefix_blocks(
        server,  # type: ignore[arg-type]
        CHAT,
        None,
        ["what did we decide on the venue?"],
        recall=True,
    )
    assert time.monotonic() - started < HINT_CAP_SECONDS + 0.5
    assert not any(b.startswith("[Possibly relevant") for b in blocks)
    assert blocks[-1].startswith("[Current local time")


async def test_the_hint_sits_after_the_profile_and_before_the_message_blocks(
    search: _Search, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.superchat import prompt_prefix

    monkeypatch.setattr(prompt_prefix, "_safe_projects_block", lambda _w: "[Projects]")

    async def _message_blocks(*_a: Any) -> list[str]:
        return ["[Attached file]"]

    async def _block(*_a: Any, **_k: Any) -> str:
        return HEADER + "\n· x\n" + FOOTER

    monkeypatch.setattr(prompt_prefix, "_message_prefix_blocks", _message_blocks)
    monkeypatch.setattr(prompt_prefix, "recall_hint_block", _block)
    blocks = await prompt_prefix.turn_prefix_blocks(
        _Server(),  # type: ignore[arg-type]
        CHAT,
        None,
        ["hello there"],
        recall=True,
    )
    assert blocks[0] == "[Attached file]" and blocks[1].startswith("[Possibly relevant")
    assert blocks[2] == "[Projects]"
    # Not asked for (a Helper): no hint.
    blocks = await prompt_prefix.turn_prefix_blocks(
        _Server(),
        CHAT,
        None,
        ["hello there"],  # type: ignore[arg-type]
    )
    assert not any(b.startswith("[Possibly relevant") for b in blocks)


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


async def test_the_setting_defaults_off_and_round_trips(client: httpx.AsyncClient) -> None:
    assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: "off"}
    for value in ("on", "off", "on"):
        resp = await client.put("/v1/me/recall-hint", json={PREFERENCE_KEY: value})
        assert resp.json() == {PREFERENCE_KEY: value}
        assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: value}


@pytest.mark.parametrize("bad", [True, "yes", None, 1])
async def test_other_values_are_refused(client: httpx.AsyncClient, bad: object) -> None:
    resp = await client.put("/v1/me/recall-hint", json={PREFERENCE_KEY: bad})
    assert resp.status_code == 400 and resp.json()["code"] == "invalid_input"
    assert (await client.get("/v1/me/recall-hint")).json() == {PREFERENCE_KEY: "off"}


def test_the_feature_is_registered_and_adds_no_tool() -> None:
    from omnigent.superchat.features import FEATURES

    (feature,) = [f for f in FEATURES if f.name == "recall_hint"]
    assert feature.tools(None, None) == []  # type: ignore[arg-type]
    assert feature.install is not None


def test_the_typed_read_id_is_shown_when_the_hit_carries_one() -> None:
    hit = _turn(7)
    hit.id = "turn:i_7"  # type: ignore[attr-defined]
    block = render_block([hit])
    assert block is not None and "recall_get" in HEADER
    assert '· 2026-09-07 · conversation · "Dana owns the venue line 7" · turn:i_7' in block


def test_likely_project_falls_back_to_paths_only_when_no_hit_has_refs() -> None:
    def file(n: int, path: str, project: str = "") -> Hit:
        return Hit("files", "2026-10-01", 0.9, title=path, file_id=f"f_{n}", project=project)

    by_path = [file(1, "projects/taxes/a.pdf"), file(2, "projects/taxes/b.xlsx"), file(3, "x.md")]
    assert "· likely Project: taxes (2 of 3 hits)" in (render_block(by_path) or "")
    # One hit with a ref: refs decide, and one ref is not a cluster.
    with_ref = [*by_path[:2], file(3, "x.md", project="spring-launch")]
    assert "likely Project" not in (render_block(with_ref) or "")
