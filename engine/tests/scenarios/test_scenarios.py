"""ADR 0025 scenarios and ADR 0029 Rounds, offline: no turn stalls, asks stay bounded, no reply
names the machinery."""

from __future__ import annotations

import pytest

from omnigent.superchat.tasks import record
from tests.scenarios.rules import (
    Event,
    as_turn,
    asks,
    checked,
    ends_well,
    gives_up,
    is_deliverable_turn,
    mechanism_words,
    speaks_first,
)
from tests.scenarios.scripts import ROUNDS, SCENARIOS, Scenario

_ALL = SCENARIOS + ROUNDS


def run(scenario: Scenario) -> list[list[Event]]:
    """A scenario's turns as the scripted model plays them."""
    return [list(turn) for turn in scenario.turns]


def test_the_adrs_name_ten_scenarios_and_six_rounds() -> None:
    assert len({scenario.name for scenario in SCENARIOS}) == 10
    assert len({scenario.name for scenario in ROUNDS}) == 6
    assert len({scenario.name for scenario in _ALL}) == 16


@pytest.mark.parametrize("scenario", _ALL, ids=lambda s: s.name)
def test_scenario_never_stalls(scenario: Scenario) -> None:
    turns = run(scenario)
    stalls = [index for index, turn in enumerate(turns) if not ends_well(turn)]
    assert stalls == [], turns
    assert not [
        text for turn in turns for kind, text in turn if kind == "reply" and gives_up(text)
    ]
    said = [
        w
        for turn in turns
        for kind, text in turn
        if kind == "reply"
        for w in mechanism_words(text)
    ]
    assert said == [], said
    asked = asks(turns)
    assert len(asked) <= scenario.max_asks
    assert len(asked) == len(set(asked)), f"asked again: {asked}"


@pytest.mark.parametrize(
    "scenario",
    [s for s in _ALL if any(is_deliverable_turn(turn) for turn in s.turns)],
    ids=lambda s: s.name,
)
def test_deliverable_scenario_speaks_first(scenario: Scenario) -> None:
    silent = [index for index, turn in enumerate(run(scenario)) if not speaks_first(turn)]
    assert silent == []


@pytest.mark.parametrize(
    "scenario", [s for s in SCENARIOS if s.deliverable == "deck"], ids=lambda s: s.name
)
def test_a_deck_scenario_ends_on_a_check_that_ran(scenario: Scenario) -> None:
    events = [event for turn in run(scenario) for event in turn]
    assert checked(events), events


@pytest.mark.parametrize(
    ("span", "ok"),
    [
        # the Helper built, saved and checked
        (
            [
                ("request", "a deck"),
                ("tool_call", "context_brief"),
                ("helper_started", ""),
                ("notice", "result"),
                ("helper_save", ""),
                ("check", "deck_check"),
            ],
            True,
        ),
        ([("request", "a deck"), ("tool_call", "deck_new"), ("save", "")], False),  # not checked
        # a save after the check needs another check
        (
            [("request", "a deck"), ("save", ""), ("tool_call", "deck_check"), ("save", "")],
            False,
        ),
        ([("request", "a deck"), ("tool_call", "deck_new"), ("cancelled", "")], True),
        ([("message", "time in Tokyo?"), ("tool_call", "web_search")], True),
        ([("request", "a deck"), ("card", "look")], True),  # nothing built
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
    assert not record.ends_well(turn) and not ends_well([("answer", "Nord"), ("reply", "Noted.")])


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
    ("text", "said"),
    [
        ("Here is the RBC vs TD comparison.", []),
        ("I started a Helper to build the deck.", ["helper"]),
        ("Two sub-agents and a worker are on it.", ["sub-agents", "worker"]),
        ("The harness stopped context_brief.", ["harness", "context_brief"]),
        ("Our helpers' coworker is helpful.", ["helpers"]),
    ],
)
def test_mechanism_words(text: str, said: list[str]) -> None:
    assert mechanism_words(text) == said


@pytest.mark.parametrize(
    ("turn", "spoken"),
    [
        ([("request", "a deck"), ("reply", "Making it."), ("tool_call", "deck_new")], True),
        ([("request", "a deck"), ("reply", "On it."), ("tool_call", "deck_new")], True),
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
        # a request opens no task until its work does, so it never stalls
        ([("request", "a deck"), ("reply", "Working on it.")], True),
        ([("request", "a deck"), ("save", "")], True),
        ([("answer", "Nord"), ("save", "")], True),
        ([("answer", "Nord"), ("helper_started", "")], True),
        ([("answer", "Nord"), ("card", "data")], True),
        ([("answer", "Nord"), ("reply", "Noted.")], False),
        ([("answer", "Nord"), ("tool_call", "deck_new"), ("reply", "Building.")], False),
        ([("steer", "add pricing"), ("message_helper", ""), ("reply", "Noted.")], True),
        ([("message", "what time is it?"), ("reply", "9 pm.")], True),
        ([("notice", "progress"), ("reply", "Two sources read.")], True),
        ([("request", "a deck"), ("tool_call", "sys_os_bash"), ("cancelled", "")], True),
    ],
)
def test_ends_well(turn: list[Event], well: bool) -> None:
    assert ends_well(turn) is well
