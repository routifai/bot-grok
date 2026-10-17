"""A new deck's look (ADR 0025): kept when the records back it, else chosen; never a card."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from omnigent.superchat.decks import kit
from omnigent.superchat.decks.authoring import handle_authoring_tool
from omnigent.superchat.decks.handlers import HELPER_ENV
from omnigent.superchat.decks.look import (
    HELPER_REFUSAL,
    choose_look,
    pick_three,
    remembered_themes,
)

from .look_fakes import ctx, deck_task, helper_ctx, view

SAMPLE = (kit.KIT_DIR / "sample-slides.html").read_text("utf-8")


@pytest.fixture(autouse=True)
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    helper = tmp_path / "fake-helper"
    report = json.dumps(json.dumps({"ok": True, "slides": 1, "issues": []}))
    helper.write_text(f"#!/usr/bin/env python3\nprint({report})\n")
    helper.chmod(helper.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(root))
    monkeypatch.setenv(HELPER_ENV, str(helper))
    return root


async def _new(look_from: str | None, template: str, call_ctx, title: str = "Sales") -> dict:
    args = {"path": "d.deck.html", "template": template, "title": title, "slides": SAMPLE}
    if look_from is not None:
        args["look_from"] = look_from
    return json.loads(await handle_authoring_tool("deck_new", args, call_ctx))


def _kept(out: dict, template: str, workspace: Path) -> bool:
    """Built in the model's template, with no look note."""
    built = out.get("written") is True and out["template"] == template
    built = built and kit.deck_theme_id((workspace / "d.deck.html").read_text("utf-8")) == template
    (workspace / "d.deck.html").unlink()
    return built and "look_note" not in out and out["deck"]["look_from"] != "chosen"


def _chosen(out: dict, workspace: Path) -> str:
    """Built in a look the engine chose; returns it."""
    assert out.get("written") is True and "card" not in out
    assert "Change look" in out["look_note"] and out["deck"]["look_from"] == "chosen"
    theme = out["template"]
    assert kit.deck_theme_id((workspace / "d.deck.html").read_text("utf-8")) == theme
    assert kit.templates()[theme].name in out["look_note"]
    (workspace / "d.deck.html").unlink()
    return theme


async def test_named_is_kept_when_the_persons_own_words_name_it(workspace: Path) -> None:
    assert _kept(await _new("named", "nord", ctx(view("A deck, use Nord"))), "nord", workspace)
    # a mood counts when it fits the theme
    out = await _new("named", "tokyo-night", ctx(view("something DARK please")))
    assert _kept(out, "tokyo-night", workspace)
    # a mood that does not fit: the engine chooses (a dark look for "dark"), no card
    theme = _chosen(await _new("named", "bauhaus", ctx(view("make it dark"))), workspace)
    assert kit.templates()[theme].category == "dark"


async def test_picked_is_backed_by_the_recorded_answer(workspace: Path) -> None:
    assert _kept(
        await _new("picked", "cartesian", ctx(view(answer="Cartesian"))), "cartesian", workspace
    )
    # the pick lives on the task: a question in between does not lose it
    later = view("what about the colours?", tasks=[deck_task("cartesian")])
    assert _kept(await _new("picked", "cartesian", ctx(later)), "cartesian", workspace)
    # another theme than the pick, or no pick at all: chosen, not refused
    _chosen(await _new("picked", "nord", ctx(later)), workspace)
    _chosen(await _new("picked", "cartesian", ctx(view("a deck"))), workspace)


async def test_you_choose_keeps_the_models_pick(workspace: Path) -> None:
    out = await _new("you_choose", "minimal-white", ctx(view("A deck. Your call!")))
    assert _kept(out, "minimal-white", workspace)
    _chosen(await _new("you_choose", "minimal-white", ctx(view("a deck"))), workspace)


async def test_background_is_kept_only_for_work_no_person_started(workspace: Path) -> None:
    assert _kept(await _new("background", "swiss-grid", helper_ctx()), "swiss-grid", workspace)
    _chosen(await _new("background", "swiss-grid", ctx(view("a deck"))), workspace)


async def test_background_with_no_topic_is_the_one_refusal_left(workspace: Path) -> None:
    for look_from in (None, "ask", "named"):
        out = await _new(look_from, "corporate-clean", helper_ctx(), title="Deck")
        assert out["error"].startswith(HELPER_REFUSAL), look_from
    assert not (workspace / "d.deck.html").exists()
    # with a topic the look is chosen, even in the background
    theme = _chosen(await _new("ask", "nord", helper_ctx(), title="Q3 revenue review"), workspace)
    assert kit.templates()[theme].category == "professional"


async def test_ask_missing_or_unknown_builds_in_a_chosen_look(workspace: Path) -> None:
    """The live failure: "Create some presentation about RBC vs TD" got a card and nothing."""
    for look_from in (None, "ask", "default", "preference"):
        call = ctx(view("Create some presentation about RBC vs TD bank results"))
        theme = _chosen(await _new(look_from, "bauhaus", call, title="RBC vs TD"), workspace)
        assert theme in ("corporate-clean", "blue-professional"), look_from
    # the menu call (no slides) names the look to use and writes nothing
    menu = json.loads(
        await handle_authoring_tool(
            "deck_new",
            {"path": "d.deck.html", "template": "nord", "look_from": "ask", "title": "Q3 sales"},
            ctx(view("a deck")),
        )
    )
    assert menu["written"] is False and "chosen for the topic" in menu["note"]
    assert menu["deck"]["look_id"] in menu["note"]
    assert not (workspace / "d.deck.html").exists()
    # no server: nothing backs a claim, so the look is chosen from the title
    _chosen(await _new("named", "nord", None, title="Board finance review"), workspace)


async def test_the_result_carries_what_the_task_records(workspace: Path) -> None:
    out = await _new("ask", "nord", ctx(view("a deck about RBC vs TD")), title="RBC vs TD")
    deck = out["deck"]
    assert deck["title"] == "RBC vs TD" and deck["file"] == "d.deck.html"
    assert (
        deck["look_id"] == out["template"]
        and deck["look"] == kit.templates()[deck["look_id"]].name
    )
    assert deck["slides"] == SAMPLE.count('<section class="slide') > 0


async def test_remembered_taste_leads_where_it_fits(workspace: Path) -> None:
    taste = "- Likes decks in Swiss Grid; dark themes like Nord for tech talks"
    assert remembered_themes(taste) == ["swiss-grid", "nord"]
    # no topic word: the first remembered look
    assert (
        _chosen(
            await _new("ask", "bauhaus", ctx(view("a deck"), profile=taste), title="Deck"),
            workspace,
        )
        == "swiss-grid"
    )
    # a business topic: the remembered look that fits it
    out = await _new("ask", "bauhaus", ctx(view(""), profile=taste), title="Q3 revenue")
    assert _chosen(out, workspace) == "swiss-grid"
    # a tech topic: Swiss Grid does not fit, Nord does
    out = await _new("ask", "bauhaus", ctx(view(""), profile=taste), title="API platform")
    assert _chosen(out, workspace) == "nord"


def _category(theme_id: str) -> str:
    return kit.templates()[theme_id].category


def test_choose_look_takes_the_first_of_the_ordering() -> None:
    assert choose_look("Seed pitch for investors") == "pitch-deck-vc"
    assert choose_look("a dark deck, maybe Nord", ["swiss-grid"]) == "nord"
    assert _category(choose_look("Our trip to Morocco: food and culture")) == "editorial"
    assert _category(choose_look("Platform architecture for engineering")) == "dark"
    assert choose_look("2026 sales") in ("corporate-clean", "blue-professional")
    assert choose_look("2026 sales") == choose_look("2026 sales")  # deterministic
    assert choose_look("", ["bauhaus"]) == "bauhaus"
    assert choose_look("", ["not-a-theme"]) == pick_three("", seed="")[0]


def test_the_ordering_offers_three_distinct_looks_fitting_the_topic() -> None:
    assert "nord" in pick_three("a dark deck, maybe Nord")
    assert pick_three("Seed pitch for investors")[0] == "pitch-deck-vc"
    assert _category(pick_three("Q3 finance review for the board")[0]) == "professional"
    assert _category(pick_three("Product launch campaign")[0]) == "bold"
    hints = ["", "dark", "editorial story", "playful kids", "Hiring plan", "Team offsite"]
    for hint in hints:
        for seed in ("a", "b", "c"):
            trio = pick_three(hint, seed=seed)
            assert len(trio) == 3 == len({_category(t) for t in trio}), (hint, seed)
    assert len({tuple(pick_three("Hiring plan", seed=f"c1|{n}")) for n in range(6)}) > 1


@pytest.mark.parametrize(
    "hint",
    [
        "2026 sales",
        "Q3 revenue review",
        "budget for the board",
        "Sales 2026 Make a 5-slide deck about our 2026 sales from sales_2026.csv",
    ],
)
def test_a_business_deck_leads_with_a_professional_look(hint: str) -> None:
    for seed in ("a", "b", "c", "d"):
        first, *others = pick_three(hint, seed=seed)
        assert first in ("corporate-clean", "blue-professional"), (hint, seed)
        assert sorted(_category(t) for t in others) == ["bold", "editorial"], (hint, seed)
