"""Run the ADR 0025 scenarios and ADR 0029's Round matrix against a live engine and report
stalls, waits and replies that name the machinery.

Sends each scenario's person messages to a freshly reset conversation, waits for each turn to
settle, and records per scenario: time to the first saved file, asks per deliverable, stalls
(a turn on a deliverable with no save, no question card and no started Helper; the rule is
``tests.scenarios.rules.ends_well``), silent turns (work before any word;
``tests.scenarios.rules.speaks_first``) and the person's wait (ADR 0026), from the engine's
item timestamps: the message's ``created_at`` to the first assistant item (first visible event)
and to the first text item (first word), the worst turn of the scenario, and for a deck scenario
(``Scenario.deliverable == "deck"``) the message to the first ``artifact_save``, in the turn or
in a Helper it started (deck end to end). Timestamps are whole seconds, so
those waits are labelled coarse and count as over budget only past a whole second. When
``OMNIGENT_SCENARIO_ENGINE_LOG`` names the engine's log file, the first visible event and the
first word come from the engine's own lines instead (sub-second, from its acceptance of the
message).
Exits non-zero on a stall, a silent turn, a reply that names the machinery
(``tests.scenarios.rules.mechanism_words``) or a wait over the budget.
``OMNIGENT_SCENARIO_BUDGET`` picks the budget: ``warm`` (default), ``cold`` or ``off``. A Round
scenario (``tests.scenarios.scripts.ROUNDS``) is held to ADR 0029's warm first words instead
(``tests.scenarios.rules.first_words_in_time``), only under ``warm``.

``--record DIR`` writes the conversation's live engine event stream (``GET
/v1/sessions/{id}/stream``) for each scenario to ``DIR/<scenario>.jsonl``, one
``{"t": seconds, "event": ...}`` line per event.

It resets and writes into the conversation of whichever account owns the token, so it refuses
to run unless ``OMNIGENT_SCENARIO_ALLOW_ACCOUNT=1`` is set, and names that account first.

Runs only when ``OMNIGENT_SCENARIO_MODEL_KEY`` is set (the engine itself holds the model
connection; the key's presence says a model is wired up), against
``OMNIGENT_SCENARIO_ENGINE_URL`` with ``OMNIGENT_SCENARIO_TOKEN`` as a bearer token:

    cd engine && uv run python scripts/scenarios.py [--record DIR] [scenario-name ...]
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.scenarios.rules import (
    FIRST_WORDS_WARM,
    Event,
    asks,
    ends_well,
    first_words_in_time,
    is_deliverable_turn,
    mechanism_words,
    speaks_first,
)
from tests.scenarios.scripts import ROUNDS, SCENARIOS, Scenario

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

    def stream(self, session_id: str) -> http.client.HTTPResponse:
        """The session's live SSE stream, open."""
        request = urllib.request.Request(
            f"{self.base_url}/v1/sessions/{session_id}/stream",
            headers={"Authorization": f"Bearer {self.token}", "Accept": "text/event-stream"},
        )
        return urllib.request.urlopen(request, timeout=60)


class Recorder:
    """Writes a conversation's live engine events to a JSONL file while a scenario plays.

    A context manager: entering opens the stream on a thread and waits until it is connected,
    leaving closes it. A stream that drops is opened again.
    """

    def __init__(self, engine: Engine, session_id: str, path: Path) -> None:
        self.engine = engine
        self.session_id = session_id
        self.path = path
        self._start = time.monotonic()
        self._connected = threading.Event()
        self._stop = threading.Event()
        self._response: http.client.HTTPResponse | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> Recorder:
        self._start = time.monotonic()
        self._thread.start()
        self._connected.wait(timeout=10)
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._response is not None:
            self._response.close()  # unblocks the reading thread
        self._thread.join(timeout=5)

    def _run(self) -> None:
        with self.path.open("w", encoding="utf-8") as out:
            while not self._stop.is_set():
                try:
                    self._response = self.engine.stream(self.session_id)
                    self._connected.set()
                    for raw in self._response:
                        data = raw.decode("utf-8", "replace").strip()
                        if not data.startswith("data:") or data == "data: [DONE]":
                            continue
                        try:
                            event = json.loads(data[5:])
                        except ValueError:
                            continue
                        at = round(time.monotonic() - self._start, 3)
                        out.write(json.dumps({"t": at, "event": event}) + "\n")
                        out.flush()
                except (OSError, ValueError, AttributeError, http.client.HTTPException):
                    pass  # closed by __exit__, timed out or dropped: open it again unless stopped
                self._stop.wait(_POLL)


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
    timestamp is missing. ``sent`` is the message's own ``created_at``.
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
        "sent": float(sent) if isinstance(sent, (int, float)) else None,
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


def helper_save(
    activities: list[dict[str, Any]], helper_ids: set[str], sent: float
) -> float | None:
    """Seconds from *sent* to the first ``artifact_save`` step of the given Helpers."""
    saves = [
        float(step["created_at"]) - sent
        for a in activities
        if str(a.get("id")) in helper_ids
        for step in a.get("steps") or []
        if str(step.get("tool") or "").rsplit("__", 1)[-1] == "artifact_save"
        and isinstance(step.get("created_at"), (int, float))
    ]
    return min(saves) if saves else None


def _wait_for_helper_save(
    engine: Engine, session_id: str, helper_ids: set[str], sent: float
) -> float | None:
    """The deck wait of a turn that handed the deck to Helpers, polling until one saves.

    Polled after the whole scenario, so a later turn can still arrive while the Helper works.
    """
    deadline = time.monotonic() + _TURN_TIMEOUT
    while True:
        activities = engine.activities(session_id)
        found = helper_save(activities, helper_ids, sent)
        running = any(
            str(a.get("id")) in helper_ids and a.get("status") == "in_progress" for a in activities
        )
        if found is not None or not running or time.monotonic() >= deadline:
            return found
        time.sleep(_POLL)


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
    engine: Engine,
    session_id: str,
    scenario: Scenario,
    log: EngineLog | None = None,
    record: Path | None = None,
) -> dict[str, Any]:
    """Play one scenario on a reset conversation and measure it.

    With *record*, the conversation's live events go to ``record/<scenario>.jsonl``.
    """
    engine.call("POST", f"/v1/sessions/{session_id}/reset", {})
    if record is None:
        return _play(engine, session_id, scenario, log)
    with Recorder(engine, session_id, record / f"{scenario.name}.jsonl"):
        return _play(engine, session_id, scenario, log)


def _play(
    engine: Engine, session_id: str, scenario: Scenario, log: EngineLog | None
) -> dict[str, Any]:
    start = time.monotonic()
    first_file: float | None = None
    turns: list[list[Event]] = []
    turn_waits: list[dict[str, float | None]] = []
    is_deck = scenario.deliverable == "deck"
    # The deck is the first turn's work that saved or started a Helper: its own save, or the
    # Helpers it started and the message's time (their save is polled after the scenario).
    deck: float | None = None
    deck_turn_seen = False
    pending: tuple[set[str], float] | None = None
    for script in scenario.turns:
        opener = script[0]
        if opener[0] not in _PERSON:
            continue  # Helper notices arrive on their own
        cancel = any(kind == "cancelled" for kind, _ in script)
        helpers_before = _helpers(engine.activities(session_id), session_id)
        turn, wait = play_turn(engine, session_id, opener, cancel, log)
        if first_file is None and any(kind == "save" for kind, _ in turn):
            first_file = time.monotonic() - start
        turns.append(turn)
        turn_waits.append(wait)
        started = _helpers(engine.activities(session_id), session_id) - helpers_before
        if is_deck and not deck_turn_seen and (wait["save"] is not None or started):
            deck_turn_seen = True
            deck = wait["save"]
            if deck is None and wait["sent"] is not None:
                pending = (started, wait["sent"])
    if pending is not None:
        deck = _wait_for_helper_save(engine, session_id, *pending)
    deliverables = sum(
        1 for turn in turns if turn[0][0] == "request" and is_deliverable_turn(turn)
    )
    return {
        "name": scenario.name,
        "first_file": first_file,
        "asks": len(asks(turns)) / max(deliverables, 1),
        "stalls": sum(1 for turn in turns if not ends_well(turn)),
        "silent": sum(1 for turn in turns if not speaks_first(turn)),
        "mechanism": sum(
            len(mechanism_words(text)) for turn in turns for kind, text in turn if kind == "reply"
        ),
        "visible": _worst([w["visible"] for w in turn_waits]),
        "word": _worst([w["word"] for w in turn_waits]),
        "deck": deck if is_deck else None,
    }


_ROUND_NAMES = frozenset(scenario.name for scenario in ROUNDS)


def over_budget(row: dict[str, Any], budget: str) -> list[str]:
    """Which of a row's waits exceed the named budget (``off`` checks nothing).

    A Round scenario is held to ADR 0029's first words only, and only under ``warm``.
    """
    if row["name"] in _ROUND_NAMES:
        if budget != "warm" or first_words_in_time(row["word"]):
            return []
        return [f"word {row['word']:.1f}s > {FIRST_WORDS_WARM:.0f}s"]
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
        f"{'mech':>4} {'visible':>7} {'word':>5} {'deck':>5}"
    ]
    for row in rows:
        lines.append(
            f"{row['name']:<28} {_seconds(row['first_file']):>10} {row['asks']:>10.1f} "
            f"{row['stalls']:>6} {row['silent']:>6} {row['mechanism']:>4} "
            f"{_seconds(row['visible']):>7} "
            f"{_seconds(row['word']):>5} {_seconds(row['deck']):>5}"
        )
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Play the scenarios against a live engine.")
    parser.add_argument("names", nargs="*", help="scenario names; all when none")
    parser.add_argument("--record", type=Path, help="write each scenario's events here")
    args = parser.parse_args(argv)
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
    wanted = set(args.names)
    chosen = [s for s in SCENARIOS + ROUNDS if not wanted or s.name in wanted]
    if args.record is not None:
        args.record.mkdir(parents=True, exist_ok=True)
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
        rows = [play(engine, session_id, scenario, log, args.record) for scenario in chosen]
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
    mechanism = sum(row["mechanism"] for row in rows)
    if mechanism:
        print(f"scenarios: {mechanism} machinery word(s) in replies", file=sys.stderr)
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
