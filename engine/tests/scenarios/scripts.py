"""The ten scenarios of ADR 0025, as data.

Each turn is the person's opener followed by what a well-behaved assistant does (the scripted
model). The offline harness runs the assistant's calls through the step-limit policy; the live
runner sends only the openers and observes what the real assistant does.
"""

from __future__ import annotations

from dataclasses import dataclass

from tests.scenarios.rules import Event


@dataclass(frozen=True)
class Scenario:
    """One scripted conversation.

    :param name: Short id, used on the command line and in the table.
    :param turns: The turns in order, each a list of events (see :mod:`tests.scenarios.rules`).
    :param max_asks: How many question cards the whole conversation may show.
    :param refusals: How many calls the step limit refuses offline.
    """

    name: str
    turns: tuple[tuple[Event, ...], ...]
    max_asks: int = 0
    refusals: int = 0


SCENARIOS: tuple[Scenario, ...] = (
    Scenario(
        "deck-from-csv",
        (
            (
                ("request", "Make a deck from sales.csv for Monday's review"),
                ("plan", ""),
                ("tool_call", "sys_os_bash"),
                ("tool_call", "deck_new"),
                ("tool_call", "deck_check"),
                ("save", ""),
                ("reply", "Here is the review deck, in Corporate Clean."),
            ),
        ),
    ),
    Scenario(
        "deck-no-look",
        (
            (
                ("request", "Create some presentation about RBC vs TD"),
                ("plan", ""),
                ("tool_call", "deck_new"),
                ("save", ""),
                ("reply", "Here is the comparison, in Pitch Deck."),
            ),
        ),
    ),
    Scenario(
        "pick-question-continue",
        (
            (
                ("request", "Make a deck on our Q3 results; ask me which look first"),
                ("card", "look"),
            ),
            (
                ("answer", "Pitch Deck"),
                ("card", "data"),
            ),
            (
                ("answer", "Use mock numbers"),
                ("tool_call", "deck_new"),
                ("save", ""),
                ("reply", "Here is the Q3 deck with mock numbers."),
            ),
        ),
        max_asks=2,
    ),
    Scenario(
        "steer-mid-helper",
        (
            (
                ("request", "Compare five CRM vendors and write it up"),
                ("plan", ""),
                ("helper_started", ""),
                ("reply", "I'm comparing the five vendors now."),
            ),
            (
                ("steer", "Include pricing too"),
                ("message_helper", ""),
                ("reply", "Pricing goes in too."),
            ),
            (
                ("notice", "result"),
                ("reply", "The comparison is ready; HubSpot is cheapest."),
            ),
        ),
    ),
    Scenario(
        "one-step-lookup",
        (
            (
                ("message", "What time is it in Tokyo?"),
                ("tool_call", "web_search"),
                ("reply", "It is 9:14 pm in Tokyo."),
            ),
        ),
    ),
    Scenario(
        "restyle-existing-deck",
        (
            (
                ("request", "Pick a different theme for the board deck"),
                ("card", "look"),
            ),
            (
                ("answer", "Nord"),
                ("tool_call", "deck_theme_set"),
                ("save", ""),
                ("reply", "The board deck is in Nord now."),
            ),
        ),
        max_asks=1,
    ),
    Scenario(
        "step-limit",
        (
            (
                ("request", "Compare the pricing pages of these four vendors in a sheet"),
                ("tool_call", "web_search"),
                ("tool_call", "browser_navigate"),
                ("tool_call", "browser_navigate"),
                ("tool_call", "browser_navigate"),
                ("helper_started", ""),
                ("reply", "I'm reading the rest of the pricing pages and building the sheet."),
            ),
        ),
        refusals=1,
    ),
    Scenario(
        "helper-flags",
        (
            (
                ("request", "Write a report on the EU AI Act obligations for our product"),
                ("plan", ""),
                ("helper_started", ""),
                ("reply", "I'm working through the obligations."),
            ),
            (
                ("notice", "flag"),
                ("reply", "Two sources disagree on the deadline; I'm using the official text."),
            ),
            (
                ("notice", "result"),
                ("reply", "The report is ready."),
            ),
        ),
    ),
    Scenario(
        "message-while-helpers-run",
        (
            (
                ("request", "Build a market-sizing deck for meal kits"),
                ("plan", ""),
                ("helper_started", ""),
                ("reply", "I'm sizing the market and building the deck."),
            ),
            (
                ("request", "Also turn last week's notes into a one-page summary"),
                ("tool_call", "sys_os_bash"),
                ("save", ""),
                ("reply", "Here is the summary; the deck is still being built."),
            ),
        ),
    ),
    Scenario(
        "cancelled-turn",
        (
            (
                ("request", "Make a 20-slide deck on the history of banking"),
                ("plan", ""),
                ("tool_call", "sys_os_bash"),
                ("cancelled", ""),
            ),
        ),
    ),
)
