"""Run the ADR 0025 scenarios against a live engine and report stalls.

Sends each scenario's person messages to a freshly reset conversation, waits for each turn to
settle, and records per scenario: time to the first saved file, asks per deliverable and stalls
(a turn on a deliverable with no save, no question card and no started Helper; the rule is
``tests.scenarios.rules.ends_well``). Exits non-zero on a stall.

Runs only when ``OMNIGENT_SCENARIO_MODEL_KEY`` is set (the engine itself holds the model
connection; the key's presence says a model is wired up), against
``OMNIGENT_SCENARIO_ENGINE_URL`` with ``OMNIGENT_SCENARIO_TOKEN`` as a bearer token:

    cd engine && uv run python scripts/scenarios.py [scenario-name ...]
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.scenarios.rules import Event, asks, ends_well, is_deliverable_turn
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


def _events(items: list[dict[str, Any]]) -> list[Event]:
    """What the assistant did, from the items a turn added."""
    events: list[Event] = []
    for item in items:
        data = item.get("data") or {}
        if item.get("type") == "function_call":
            name = str(data.get("name") or "").rsplit("__", 1)[-1]
            kind = _EVENT_FOR_TOOL.get(name)
            events.append((kind, "") if kind else ("tool_call", name))
        elif item.get("type") == "message" and data.get("role") == "assistant":
            content = data.get("content") or []
            text = " ".join(str(c.get("text") or "") for c in content if isinstance(c, dict))
            events.append(("reply", text))
    return events


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


def play_turn(engine: Engine, session_id: str, opener: Event, cancel: bool) -> list[Event]:
    """Send one person message, wait for the turn to settle, return the turn's events."""
    before = len(engine.items(session_id))
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
            item.get("type") != "message" or (item.get("data") or {}).get("role") != "user"
            for item in items
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
            return events
    return [opener, ("reply", "timed out")]


def play(engine: Engine, session_id: str, scenario: Scenario) -> dict[str, Any]:
    """Play one scenario on a reset conversation and measure it."""
    engine.call("POST", f"/v1/sessions/{session_id}/reset", {})
    start = time.monotonic()
    first_file: float | None = None
    turns: list[list[Event]] = []
    for script in scenario.turns:
        opener = script[0]
        if opener[0] not in _PERSON:
            continue  # Helper notices arrive on their own
        cancel = any(kind == "cancelled" for kind, _ in script)
        turn = play_turn(engine, session_id, opener, cancel)
        if first_file is None and any(kind == "save" for kind, _ in turn):
            first_file = time.monotonic() - start
        turns.append(turn)
    deliverables = sum(
        1 for turn in turns if turn[0][0] == "request" and is_deliverable_turn(turn)
    )
    return {
        "name": scenario.name,
        "first_file": first_file,
        "asks": len(asks(turns)) / max(deliverables, 1),
        "stalls": sum(1 for turn in turns if not ends_well(turn)),
    }


def _table(rows: list[dict[str, Any]]) -> str:
    lines = [f"{'scenario':<28} {'first file':>10} {'asks/deliv':>10} {'stalls':>6}"]
    for row in rows:
        first = f"{row['first_file']:.0f}s" if row["first_file"] is not None else "-"
        lines.append(f"{row['name']:<28} {first:>10} {row['asks']:>10.1f} {row['stalls']:>6}")
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
    wanted = set(argv)
    chosen = [s for s in SCENARIOS if not wanted or s.name in wanted]
    engine = Engine(url, token)
    try:
        session_id = str(engine.call("GET", "/v1/me/muse")["session_id"])
        rows = [play(engine, session_id, scenario) for scenario in chosen]
    except urllib.error.URLError as exc:
        print(f"scenarios: engine unreachable: {exc}", file=sys.stderr)
        return 2
    print(_table(rows))
    stalls = sum(row["stalls"] for row in rows)
    if stalls:
        print(f"scenarios: {stalls} stalled turn(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
