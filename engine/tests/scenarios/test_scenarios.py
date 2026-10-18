"""ADR 0025 scenarios, offline: no turn stalls, asks stay bounded, the step limit hands off."""

from __future__ import annotations

import pytest

from omnigent.superchat.step_limit.policy import LIMIT_ENV
from omnigent.superchat.tasks import record
from tests.scenarios.harness import run
from tests.scenarios.rules import (
    Event,
    as_turn,
    asks,
    checked,
    ends_well,
    gives_up,
    is_deliverable_turn,
    plan_spans,
    speaks_first,
)
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
    assert not [
        text for turn in turns for kind, text in turn if kind == "reply" and gives_up(text)
    ]
    asked = asks(turns)
    assert len(asked) <= scenario.max_asks
    assert len(asked) == len(set(asked)), f"asked again: {asked}"
    refused = [detail for turn in turns for kind, detail in turn if kind == "refused"]
    assert len(refused) == scenario.refusals


@pytest.mark.parametrize(
    "scenario",
    [s for s in SCENARIOS if any(is_deliverable_turn(turn) for turn in s.turns)],
    ids=lambda s: s.name,
)
def test_deliverable_scenario_speaks_first(scenario: Scenario) -> None:
    silent = [index for index, turn in enumerate(run(scenario)) if not speaks_first(turn)]
    assert silent == []


@pytest.mark.parametrize(
    "scenario", [s for s in SCENARIOS if s.deliverable == "deck"], ids=lambda s: s.name
)
def test_a_deck_scenarios_plan_ends_on_a_check_that_ran(scenario: Scenario) -> None:
    spans = plan_spans(run(scenario))
    assert spans and all(checked(span) for span in spans), spans


@pytest.mark.parametrize(
    ("span", "ok"),
    [
        # the Helper built, saved and checked: the check step is done
        (
            [
                ("request", "a deck"),
                ("tool_call", "context_brief"),
                ("plan", "brief,helper_done,check_ran"),
                ("helper_started", ""),
                ("notice", "result"),
                ("helper_save", ""),
                ("check", "deck_check"),
            ],
            True,
        ),
        # the plan says check, nothing checked: not checked
        ([("request", "a deck"), ("plan", "brief,check_ran"), ("save", "")], False),
        # a check before anything was built proves nothing
        (
            [("request", "a deck"), ("plan", "check_ran"), ("tool_call", "deck_check")],
            False,
        ),
        ([("request", "a deck"), ("plan", "saved"), ("save", "")], False),  # no check step
        ([("request", "a deck"), ("plan", "check_ran"), ("cancelled", "")], True),
        ([("message", "time in Tokyo?"), ("tool_call", "web_search")], True),
        ([("request", "a deck"), ("tool_call", "deck_new"), ("save", "")], True),  # no plan
    ],
)
def test_checked(span: list[Event], ok: bool) -> None:
    assert checked(span) is ok


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


def test_the_adr_transcript_stalls_gives_up_and_asks_again() -> None:
    # the last answer ends with no file, card or Helper: the engine logs a stall
    assert [ends_well(turn) for turn in _RBC_VS_TD] == [True, True, True, False]
    replies = [[text for kind, text in turn if kind == "reply"] for turn in _RBC_VS_TD]
    assert [any(gives_up(text) for text in turn) for turn in replies] == [False, True, False, True]
    assert asks(_RBC_VS_TD) == ["look", "data", "look"]


def test_the_scenarios_judge_a_turn_with_the_engines_rule() -> None:
    turn = as_turn([("answer", "Nord"), ("reply", "Noted.")])
    assert record.is_stall(turn) and not ends_well([("answer", "Nord"), ("reply", "Noted.")])


# The turn in ADR 0026's opening: the first output was the deck_new call, no word for 182 s.
_RBC_VS_TD_SILENT: list[Event] = [
    ("request", "create some presentation about rbc vs td"),
    ("tool_call", "deck_new"),
    ("tool_call", "deck_check"),
    ("save", ""),
    ("reply", "Here is the RBC vs TD comparison."),
]


def test_the_adr_0026_transcript_does_not_speak_first() -> None:
    assert ends_well(_RBC_VS_TD_SILENT)
    assert not speaks_first(_RBC_VS_TD_SILENT)


@pytest.mark.parametrize(
    ("turn", "spoken"),
    [
        ([("request", "a deck"), ("reply", "Making it."), ("tool_call", "deck_new")], True),
        ([("request", "a deck"), ("plan", ""), ("tool_call", "deck_new")], True),
        ([("request", "a deck"), ("helper_started", ""), ("reply", "On it.")], False),
        ([("request", "a deck"), ("card", "look")], True),
        ([("answer", "Nord"), ("tool_call", "deck_theme_set")], False),
        ([("message", "time in Tokyo?"), ("tool_call", "web_search")], True),
    ],
)
def test_speaks_first(turn: list[Event], spoken: bool) -> None:
    assert speaks_first(turn) is spoken


@pytest.mark.parametrize(
    ("turn", "well"),
    [
        # a request opens no task until its work does: only its refusals can stall it
        ([("request", "a deck"), ("plan", ""), ("reply", "Working on it.")], True),
        ([("request", "a deck"), ("save", "")], True),
        ([("answer", "Nord"), ("save", "")], True),
        ([("answer", "Nord"), ("helper_started", "")], True),
        ([("answer", "Nord"), ("card", "data")], True),
        ([("answer", "Nord"), ("reply", "Noted.")], False),
        ([("answer", "Nord"), ("tool_call", "deck_new"), ("reply", "Building.")], False),
        ([("steer", "add pricing"), ("message_helper", ""), ("reply", "Noted.")], True),
        ([("message", "what time is it?"), ("reply", "9 pm.")], True),
        ([("notice", "progress"), ("reply", "Two sources read.")], True),
        ([("notice", "result"), ("refused", "web_search"), ("reply", "Busy.")], True),
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
        "reply",
        "tool_call",
        "tool_call",
        "tool_call",
        "refused",
        "helper_started",
        "reply",
    ]
