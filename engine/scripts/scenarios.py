"""Run the ADR 0025 scenarios against a live engine and report stalls and waits.

Sends each scenario's person messages to a freshly reset conversation, waits for each turn to
settle, and records per scenario: time to the first saved file, asks per deliverable, stalls
(a turn on a deliverable with no save, no question card and no started Helper; the rule is
``tests.scenarios.rules.ends_well``), silent turns (work before any word;
``tests.scenarios.rules.speaks_first``) and the person's wait (ADR 0026), from the engine's
item timestamps: the message's ``created_at`` to the first assistant item (first visible event)
and to the first text item (first word), the worst turn of the scenario, and for a deck scenario
the message to the first ``artifact_save`` (deck end to end). Timestamps are whole seconds, so
those waits are labelled coarse and count as over budget only past a whole second. When
``OMNIGENT_SCENARIO_ENGINE_LOG`` names the engine's log file, the first visible event and the
first word come from the engine's own lines instead (sub-second, from its acceptance of the
message).
Exits non-zero on a stall, a silent turn or a wait over the budget. ``OMNIGENT_SCENARIO_BUDGET``
picks the budget: ``warm`` (default), ``cold`` or ``off``.

It resets and writes into the conversation of whichever account owns the token, so it refuses
to run unless ``OMNIGENT_SCENARIO_ALLOW_ACCOUNT=1`` is set, and names that account first.

Runs only when ``OMNIGENT_SCENARIO_MODEL_KEY`` is set (the engine itself holds the model
connection; the key's presence says a model is wired up), against
``OMNIGENT_SCENARIO_ENGINE_URL`` with ``OMNIGENT_SCENARIO_TOKEN`` as a bearer token:

    cd engine && uv run python scripts/scenarios.py [scenario-name ...]
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.scenarios.rules import Event, asks, ends_well, is_deliverable_turn, speaks_first
from tests.scenarios.scripts import SCENARIOS, Scenario

_PERSON = frozenset({"request", "answer", "message", "steer"})
#: Tool names that map to a rule event; any other call is a plain ``tool_call``.
_EVENT_FOR_TOOL = {
    "artifact_save": "save",
    "ask_clarification": "card",
    "start_helper": "helper_started",
    "message_helper": "message_helper",
}
_TURN_TIMEOUT = 900.0
#: The engine's per-turn wait lines (``omnigent.server.routes._sessions.turn_metrics``).
_LOG_LINES = {
    "visible": re.compile(r"first visible event for (\S+) ([\d.]+)s after the message"),
    "word": re.compile(r"first word for (\S+) ([\d.]+)s after the message"),
}
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
#: ADR 0026's budget in seconds: first visible event, first word, a deck from send to card.
BUDGETS: dict[str, dict[str, float]] = {
    "warm": {"visible": 1.0, "word": 2.0, "deck": 60.0},
    "cold": {"visible": 10.0, "word": 12.0, "deck": 75.0},
}
_POLL = 2.0


class Engine:
    """The few engine routes the runner needs, over plain HTTP."""

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
        return json.loads(raw) if raw else None

    def items(self, session_id: str) -> list[dict[str, Any]]:
        snapshot = self.call("GET", f"/v1/sessions/{session_id}?include_liveness=false")
        return list(snapshot.get("items") or [])

    def status(self, session_id: str) -> str:
        path = f"/v1/sessions/{session_id}?include_items=false&include_liveness=false"
        return str(self.call("GET", path).get("status") or "")

    def activities(self, session_id: str) -> list[dict[str, Any]]:
        page = self.call("GET", f"/v1/sessions/{session_id}/activities?limit=100")
        return list(page.get("data") or [])

    def send(self, session_id: str, text: str) -> None:
        message = {"role": "user", "content": [{"type": "input_text", "text": text}]}
        self.call(
            "POST", f"/v1/sessions/{session_id}/events", {"type": "message", "data": message}
        )

    def interrupt(self, session_id: str) -> None:
        self.call("POST", f"/v1/sessions/{session_id}/events", {"type": "interrupt", "data": {}})


def _fields(item: dict[str, Any]) -> dict[str, Any]:
    """An item's type-specific fields: flat on the API shape, under ``data`` on older shapes."""
    data = item.get("data")
    return data if isinstance(data, dict) else item


def _tool(item: dict[str, Any]) -> str:
    return str(_fields(item).get("name") or "").rsplit("__", 1)[-1]


def _is_text(item: dict[str, Any]) -> bool:
    fields = _fields(item)
    return item.get("type") == "message" and fields.get("role") == "assistant"


def _events(items: list[dict[str, Any]]) -> list[Event]:
    """What the assistant did, from the items a turn added."""
    events: list[Event] = []
    for item in items:
        if item.get("type") == "function_call":
            name = _tool(item)
            kind = _EVENT_FOR_TOOL.get(name)
            events.append((kind, "") if kind else ("tool_call", name))
        elif _is_text(item):
            content = _fields(item).get("content") or []
            text = " ".join(str(c.get("text") or "") for c in content if isinstance(c, dict))
            events.append(("reply", text))
    return events


def waits(items: list[dict[str, Any]]) -> dict[str, float | None]:
    """The person's wait in one turn, in seconds from their message's ``created_at``.

    ``visible``: to the first assistant item (a word or a tool call); ``word``: to the first
    text item; ``save``: to the first ``artifact_save``. ``None`` when it did not happen or a
    timestamp is missing.
    """
    sent = next(
        (
            item.get("created_at")
            for item in items
            if item.get("type") == "message" and _fields(item).get("role") == "user"
        ),
        None,
    )

    def after(match: Any) -> float | None:
        at = next((item.get("created_at") for item in items if match(item)), None)
        if not isinstance(sent, (int, float)) or not isinstance(at, (int, float)):
            return None
        return float(at - sent)

    return {
        "visible": after(lambda i: i.get("type") == "function_call" or _is_text(i)),
        "word": after(_is_text),
        "save": after(lambda i: i.get("type") == "function_call" and _tool(i) == "artifact_save"),
    }


class EngineLog:
    """The engine's log file, read from where the previous turn left off."""

    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.offset = self.path.stat().st_size if self.path.exists() else 0

    def mark(self) -> None:
        """Skip everything logged so far."""
        self.offset = self.path.stat().st_size if self.path.exists() else 0

    def waits(self, session_id: str) -> dict[str, float | None]:
        """The engine's first visible event and first word for *session_id* since :meth:`mark`."""
        found: dict[str, float | None] = dict.fromkeys(_LOG_LINES)
        with self.path.open(encoding="utf-8", errors="replace") as log:
            log.seek(self.offset)
            for line in log:
                clean = _ANSI.sub("", line)
                for key, pattern in _LOG_LINES.items():
                    match = pattern.search(clean)
                    if match and match.group(1) == session_id and found[key] is None:
                        found[key] = float(match.group(2))
        return found


def _worst(values: list[float | None]) -> float | None:
    known = [value for value in values if value is not None]
    return max(known) if known else None


def _turn_running(activities: list[dict[str, Any]], session_id: str) -> bool:
    return any(
        a.get("kind") == "turn"
        and a.get("chat_id") == session_id
        and a.get("status") == "in_progress"
        for a in activities
    )


def _helpers(activities: list[dict[str, Any]], session_id: str) -> set[str]:
    return {
        str(a.get("id"))
        for a in activities
        if a.get("kind") == "sub_agent" and a.get("parent_chat_id") == session_id
    }


def play_turn(
    engine: Engine, session_id: str, opener: Event, cancel: bool, log: EngineLog | None = None
) -> tuple[list[Event], dict[str, float | None]]:
    """Send one person message, wait for the turn to settle, return its events and waits."""
    before = len(engine.items(session_id))
    if log is not None:
        log.mark()
    helpers_before = _helpers(engine.activities(session_id), session_id)
    engine.send(session_id, opener[1])
    if cancel:
        time.sleep(5 * _POLL)
        engine.interrupt(session_id)
    deadline = time.monotonic() + _TURN_TIMEOUT
    seen, quiet = -1, 0
    while time.monotonic() < deadline:
        time.sleep(_POLL)
        items = engine.items(session_id)[before:]
        activities = engine.activities(session_id)
        started = _helpers(activities, session_id) - helpers_before
        answered = any(
            item.get("type") != "message" or _fields(item).get("role") != "user" for item in items
        )
        idle = engine.status(session_id) == "idle" or bool(started)
        settled = answered and idle and not _turn_running(activities, session_id)
        quiet = quiet + 1 if settled and len(items) == seen else 0
        seen = len(items)
        if quiet >= 2:
            events = [opener, *_events(items)]
            if started and ("helper_started", "") not in events:
                events.append(("helper_started", ""))
            if cancel:
                events.append(("cancelled", ""))
            turn_waits = waits(items)
            if log is not None:
                turn_waits.update(log.waits(session_id))
            return events, turn_waits
    return [opener, ("reply", "timed out")], waits([])


def play(
    engine: Engine, session_id: str, scenario: Scenario, log: EngineLog | None = None
) -> dict[str, Any]:
    """Play one scenario on a reset conversation and measure it."""
    engine.call("POST", f"/v1/sessions/{session_id}/reset", {})
    start = time.monotonic()
    first_file: float | None = None
    turns: list[list[Event]] = []
    turn_waits: list[dict[str, float | None]] = []
    for script in scenario.turns:
        opener = script[0]
        if opener[0] not in _PERSON:
            continue  # Helper notices arrive on their own
        cancel = any(kind == "cancelled" for kind, _ in script)
        turn, wait = play_turn(engine, session_id, opener, cancel, log)
        if first_file is None and any(kind == "save" for kind, _ in turn):
            first_file = time.monotonic() - start
        turns.append(turn)
        turn_waits.append(wait)
    is_deck = any(
        event == ("tool_call", "deck_new") for script in scenario.turns for event in script
    )
    deliverables = sum(
        1 for turn in turns if turn[0][0] == "request" and is_deliverable_turn(turn)
    )
    return {
        "name": scenario.name,
        "first_file": first_file,
        "asks": len(asks(turns)) / max(deliverables, 1),
        "stalls": sum(1 for turn in turns if not ends_well(turn)),
        "silent": sum(1 for turn in turns if not speaks_first(turn)),
        "visible": _worst([w["visible"] for w in turn_waits]),
        "word": _worst([w["word"] for w in turn_waits]),
        "deck": next((w["save"] for w in turn_waits if w["save"] is not None), None)
        if is_deck
        else None,
    }


def over_budget(row: dict[str, Any], budget: str) -> list[str]:
    """Which of a row's waits exceed the named budget (``off`` checks nothing)."""
    limits = BUDGETS.get(budget)
    if limits is None:
        return []
    return [
        f"{key} {row[key]:.0f}s > {limit:.0f}s"
        for key, limit in limits.items()
        if row.get(key) is not None and row[key] > limit
    ]


def _seconds(value: float | None) -> str:
    return f"{value:.1f}s" if value is not None else "-"


def _table(rows: list[dict[str, Any]]) -> str:
    lines = [
        f"{'scenario':<28} {'first file':>10} {'asks/deliv':>10} {'stalls':>6} {'silent':>6} "
        f"{'visible':>7} {'word':>5} {'deck':>5}"
    ]
    for row in rows:
        lines.append(
            f"{row['name']:<28} {_seconds(row['first_file']):>10} {row['asks']:>10.1f} "
            f"{row['stalls']:>6} {row['silent']:>6} {_seconds(row['visible']):>7} "
            f"{_seconds(row['word']):>5} {_seconds(row['deck']):>5}"
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    url = os.environ.get("OMNIGENT_SCENARIO_ENGINE_URL")
    token = os.environ.get("OMNIGENT_SCENARIO_TOKEN")
    if not os.environ.get("OMNIGENT_SCENARIO_MODEL_KEY") or not url or not token:
        print(
            "scenarios: skipped; set OMNIGENT_SCENARIO_MODEL_KEY, OMNIGENT_SCENARIO_ENGINE_URL "
            "and OMNIGENT_SCENARIO_TOKEN to run against a live engine."
        )
        return 0
    budget = os.environ.get("OMNIGENT_SCENARIO_BUDGET", "warm")
    if budget not in {*BUDGETS, "off"}:
        print("scenarios: OMNIGENT_SCENARIO_BUDGET is warm, cold or off", file=sys.stderr)
        return 2
    wanted = set(argv)
    chosen = [s for s in SCENARIOS if not wanted or s.name in wanted]
    engine = Engine(url, token)
    log_path = os.environ.get("OMNIGENT_SCENARIO_ENGINE_LOG")
    log = EngineLog(log_path) if log_path else None
    try:
        account = engine.call("GET", "/v1/me").get("user_id") or "the single-user account"
        print(f"scenarios: this resets and writes into the conversation of {account}")
        if os.environ.get("OMNIGENT_SCENARIO_ALLOW_ACCOUNT") != "1":
            print(
                "scenarios: refused; set OMNIGENT_SCENARIO_ALLOW_ACCOUNT=1 to use this account",
                file=sys.stderr,
            )
            return 2
        session_id = str(engine.call("GET", "/v1/me/muse")["session_id"])
        rows = [play(engine, session_id, scenario, log) for scenario in chosen]
    except urllib.error.URLError as exc:
        print(f"scenarios: engine unreachable: {exc}", file=sys.stderr)
        return 2
    print(_table(rows))
    print(
        "waits: visible and word from the engine log"
        if log is not None
        else "waits: coarse (item timestamps, whole seconds); "
        "set OMNIGENT_SCENARIO_ENGINE_LOG for the engine's own"
    )
    failed = False
    stalls = sum(row["stalls"] for row in rows)
    if stalls:
        print(f"scenarios: {stalls} stalled turn(s)", file=sys.stderr)
        failed = True
    silent = sum(row["silent"] for row in rows)
    if silent:
        print(f"scenarios: {silent} turn(s) worked before a word", file=sys.stderr)
        failed = True
    for row in rows:
        over = over_budget(row, budget)
        if over:
            print(
                f"scenarios: {row['name']} over the {budget} budget: {', '.join(over)}",
                file=sys.stderr,
            )
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
