"""Offline scenario harness: a scripted model whose calls go through the real step-limit policy."""

from __future__ import annotations

from typing import Any

from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE
from omnigent.superchat.step_limit.policy import STATE_KEY, muse_step_limit
from tests.scenarios.rules import Event
from tests.scenarios.scripts import Scenario

_CHAT = {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}
#: The tool behind each assistant event that is not a plain ``tool_call``.
_TOOL = {
    "card": "ask_clarification",
    "helper_started": "start_helper",
    "message_helper": "message_helper",
    "save": "artifact_save",
}
_PERSON = frozenset({"request", "answer", "message", "steer"})


def _request(opener: Event) -> dict[str, Any]:
    kind, text = opener
    return {
        "type": "request",
        "data": {"user_content": text, "attachments": [], "is_system_notice": kind not in _PERSON},
        "context": {"labels": _CHAT},
    }


def _call(name: str, state: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "tool_call",
        "data": {"name": name, "arguments": {}},
        "context": {"labels": _CHAT},
        "session_state": {STATE_KEY: state},
    }


def run(scenario: Scenario) -> list[list[Event]]:
    """Play a scenario and return each turn as it happened: a refused call becomes ``refused``."""
    turns: list[list[Event]] = []
    for script in scenario.turns:
        opener, *steps = script
        reset = muse_step_limit(_request(opener)) or {}
        state = reset["state_updates"][0]["value"] if reset.get("state_updates") else {}
        played: list[Event] = [opener]
        for kind, detail in steps:
            name = detail if kind == "tool_call" else _TOOL.get(kind)
            if name is not None:
                verdict = muse_step_limit(_call(name, state))
                if verdict is not None and verdict["result"] == "DENY":
                    played.append(("refused", name))
                    continue
                if verdict is not None and verdict.get("state_updates"):
                    state = verdict["state_updates"][0]["value"]
            played.append((kind, detail))
        turns.append(played)
    return turns
