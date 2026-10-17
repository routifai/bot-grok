"""ADR 0025 scenarios, offline: no turn stalls, asks stay bounded, the step limit hands off."""

from __future__ import annotations

import pytest

from omnigent.superchat.step_limit.policy import LIMIT_ENV
from tests.scenarios.harness import run
from tests.scenarios.rules import Event, asks, ends_well
from tests.scenarios.scripts import SCENARIOS, Scenario


@pytest.fixture(autouse=True)
def _default_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(LIMIT_ENV, "3")


def test_the_adr_names_ten_scenarios() -> None:
    assert len({scenario.name for scenario in SCENARIOS}) == 10


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
def test_scenario_never_stalls(scenario: Scenario) -> None:
    turns = run(scenario)
    stalls = [index for index, turn in enumerate(turns) if not ends_well(turn)]
    assert stalls == [], turns
    asked = asks(turns)
    assert len(asked) <= scenario.max_asks
    assert len(asked) == len(set(asked)), f"asked again: {asked}"
    refused = [detail for turn in turns for kind, detail in turn if kind == "refused"]
    assert len(refused) == scenario.refusals


# The conversation in ADR 0025's opening: four turns, nothing built.
_RBC_VS_TD: list[list[Event]] = [
    [("request", "Create some presentation about RBC vs TD"), ("card", "look")],
    [
        ("answer", "Pitch Deck"),
        ("reply", "I haven't built it yet, so I'll stop here for now."),
        ("card", "data"),
    ],
    [("answer", "Mock data"), ("card", "look")],
    [
        ("answer", "Bold Signal"),
        (
            "reply",
            "My last attempt didn't register your choice; send me a short message to continue.",
        ),
    ],
]


def test_the_adr_transcript_stalls_and_asks_again() -> None:
    assert [ends_well(turn) for turn in _RBC_VS_TD] == [True, False, True, False]
    assert asks(_RBC_VS_TD) == ["look", "data", "look"]


@pytest.mark.parametrize(
    ("turn", "well"),
    [
        ([("request", "a deck"), ("plan", ""), ("reply", "Working on it.")], False),
        ([("request", "a deck"), ("save", "")], True),
        ([("request", "a deck"), ("helper_started", "")], True),
        ([("request", "a deck"), ("card", "look")], True),
        ([("answer", "Nord"), ("reply", "Noted.")], False),
        ([("message", "what time is it?"), ("reply", "9 pm.")], True),
        ([("notice", "progress"), ("reply", "Two sources read.")], True),
        ([("request", "a deck"), ("tool_call", "sys_os_bash"), ("cancelled", "")], True),
        ([("request", "a sheet"), ("refused", "browser_navigate"), ("save", "")], False),
        ([("message", "look it up"), ("refused", "web_search"), ("reply", "Busy.")], False),
        ([("request", "a sheet"), ("refused", "web_search"), ("helper_started", "")], True),
    ],
)
def test_ends_well(turn: list[Event], well: bool) -> None:
    assert ends_well(turn) is well


def test_the_step_limit_turns_the_fourth_work_call_into_a_refusal() -> None:
    (turn,) = run(next(s for s in SCENARIOS if s.name == "step-limit"))
    assert [kind for kind, _ in turn] == [
        "request",
        "tool_call",
        "tool_call",
        "tool_call",
        "refused",
        "helper_started",
        "reply",
    ]
