"""A Helper's progress and flag notices to the chat that started it (ADR 0022)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from omnigent.context.labels import (
    CONTEXT_MODE_LABEL,
    SUBAGENT_LABEL_KEY,
    SUPERSIDE_CHAT_MODE_VALUE,
)
from omnigent.superchat.feature import HandlerCtx, ToolManagerCtx
from omnigent.superchat.helpers import notices
from omnigent.superchat.helpers.feature import HELPERS_FEATURE
from omnigent.superchat.helpers.notices import (
    PROGRESS_INTERVAL_S,
    HelperInfo,
    HelperNotices,
    notice_text,
    take_waiting_progress,
)

CHAT = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
HELPER = {**CHAT, SUBAGENT_LABEL_KEY: "1"}
PARENT = "p" * 32


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture()
def posted(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Fresh notice state, a fake clock, and every notice posted to a parent."""
    clock = _Clock()
    state: dict[str, Any] = {"clock": clock, "posts": [], "running": True}
    monkeypatch.setattr(notices, "NOTICES", HelperNotices(clock))

    async def _info(_client: Any, helper_id: str) -> HelperInfo:
        return HelperInfo(parent_id=PARENT, name=f"Helper {helper_id[:1]}", started_at=0.0)

    async def _post(_client: Any, parent_id: str, notice: str, *, if_running: bool) -> bool:
        state["posts"].append((parent_id, notice, if_running))
        return state["running"] or not if_running

    monkeypatch.setattr(notices, "_helper_info", _info)
    monkeypatch.setattr(notices, "post_notice", _post)
    return state


def _ctx(tool: str, helper: str = "a" * 32) -> HandlerCtx:
    return HandlerCtx(tool, object(), helper, HELPER)  # type: ignore[arg-type]


def _call(tool: str, text: str, helper: str = "a" * 32) -> dict[str, Any]:
    handler = HELPERS_FEATURE.handlers[tool]
    return json.loads(asyncio.run(handler(_ctx(tool, helper), {"text": text})))


def test_the_notice_tools_are_offered_to_helpers_only() -> None:
    names = {t.name() for t in HELPERS_FEATURE.tools(HELPER, ToolManagerCtx())}
    assert {"report_progress", "raise_flag"} <= names
    assert not {"report_progress", "raise_flag"} & {
        t.name() for t in HELPERS_FEATURE.tools(CHAT, ToolManagerCtx())
    }
    assert HELPERS_FEATURE.tools({}, ToolManagerCtx()) == []


def test_notice_text_forms() -> None:
    assert notice_text("progress", "Q3 deck", "Read the ledger") == (
        "[helper Q3 deck] progress: Read the ledger"
    )
    assert (
        notice_text("flag", "Q3 deck", "Used the ledger")
        == "[helper Q3 deck] flag: Used the ledger"
    )


def test_progress_steers_a_live_parent_and_is_throttled(posted) -> None:
    assert _call("report_progress", "Read the ledger") == {"ok": True}
    assert posted["posts"] == [(PARENT, "[helper Helper a] progress: Read the ledger", True)]

    async def two_quick_steps() -> None:
        handler = HELPERS_FEATURE.handlers["report_progress"]
        await handler(_ctx("report_progress"), {"text": "Compared the totals"})
        await handler(_ctx("report_progress"), {"text": "Wrote slide 1"})
        # Within the interval nothing more goes out; the newer step replaced the older.
        assert len(posted["posts"]) == 1
        assert notices.NOTICES.waiting(PARENT, "a" * 32) == (
            "[helper Helper a] progress: Wrote slide 1"
        )
        await asyncio.sleep(0)

    asyncio.run(two_quick_steps())
    posted["clock"].now += PROGRESS_INTERVAL_S
    # Once the interval has passed, the next step goes out at once.
    _call("report_progress", "Wrote slide 2")
    assert posted["posts"][-1] == (PARENT, "[helper Helper a] progress: Wrote slide 2", True)


def test_a_held_back_progress_goes_when_its_interval_ends(posted, monkeypatch) -> None:
    monkeypatch.setattr(notices, "PROGRESS_INTERVAL_S", 0.05)

    async def run() -> None:
        handler = HELPERS_FEATURE.handlers["report_progress"]
        await handler(_ctx("report_progress"), {"text": "one"})
        posted["clock"].now += 0.01
        await handler(_ctx("report_progress"), {"text": "two"})
        await handler(_ctx("report_progress"), {"text": "three"})
        assert [p[1] for p in posted["posts"]] == ["[helper Helper a] progress: one"]
        await asyncio.sleep(0.2)

    asyncio.run(run())
    assert [p[1] for p in posted["posts"]] == [
        "[helper Helper a] progress: one",
        "[helper Helper a] progress: three",
    ]


def test_progress_to_an_idle_parent_waits_for_the_next_wake(posted) -> None:
    posted["running"] = False
    _call("report_progress", "Read file one", helper="a" * 32)
    _call("report_progress", "Read file two", helper="a" * 32)
    _call("report_progress", "Found 3 vendors", helper="b" * 32)
    # Folded into the next wake: one line per Helper, newest only; a finished Helper's line goes.
    assert take_waiting_progress(PARENT, done="b" * 32) == [
        "[helper Helper a] progress: Read file two"
    ]
    assert take_waiting_progress(PARENT) == []


def test_a_flag_always_wakes_the_parent_and_carries_waiting_progress(posted) -> None:
    posted["running"] = False
    _call("report_progress", "Read the ledger")
    assert _call("raise_flag", "The ledger and the board pack disagree; using the ledger") == {
        "ok": True
    }
    parent, body, if_running = posted["posts"][-1]
    assert (parent, if_running) == (PARENT, False)  # a wake: steered when live, else a new turn
    assert body.splitlines() == [
        "[helper Helper a] progress: Read the ledger",
        "[helper Helper a] flag: The ledger and the board pack disagree; using the ledger",
    ]
    # Flags are never throttled.
    _call("raise_flag", "Q2 is missing from the ledger")
    assert posted["posts"][-1][1] == "[helper Helper a] flag: Q2 is missing from the ledger"


def test_a_notice_needs_text_and_a_helper(posted, monkeypatch) -> None:
    assert "error" in _call("report_progress", "   ")

    async def _not_a_helper(_client: Any, _helper_id: str) -> None:
        return None

    monkeypatch.setattr(notices, "_helper_info", _not_a_helper)
    assert "error" in _call("raise_flag", "hello")
    assert posted["posts"] == []


def test_the_activity_shows_both_notices_as_plain_lines_of_the_helper() -> None:
    from omnigent.superchat.activity.derive import step_title_for_call

    progress = json.dumps({"text": "Read the Q3 ledger"})
    flag = json.dumps({"text": "Using the ledger, not the board pack"})
    assert step_title_for_call("report_progress", progress) == "Read the Q3 ledger"
    assert step_title_for_call("raise_flag", flag) == (
        "Flagged: Using the ledger, not the board pack"
    )
