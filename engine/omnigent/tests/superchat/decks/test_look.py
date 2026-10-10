"""The look gate: deck_new builds only in a look the records show the person chose."""

from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from omnigent.context.labels import SCHEDULED_FIRE_LABEL_KEY
from omnigent.inner.executor import result_ends_turn
from omnigent.superchat.decks import kit
from omnigent.superchat.decks.authoring import handle_authoring_tool
from omnigent.superchat.decks.handlers import HELPER_ENV, handle_deck_tool
from omnigent.superchat.decks.look import HELPER_REFUSAL, pick_three
from omnigent.superchat.transcript.blocks import project_items

from .look_fakes import card_call, card_output, ctx, helper_ctx, user

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


def _built(out: dict) -> bool:
    return out.get("written") is True


def _is_card(out: dict, workspace: Path) -> bool:
    """The "Which look?" card: 3 distinct deck themes, ends the turn, nothing written."""
    themes = [o["preview"]["id"] for o in out["data"]["options"]]
    categories = {kit.templates()[t].category for t in themes}
    return (
        out["type"] == "card"
        and out["card"] == "ask"
        and out["data"]["question"] == "Which look?"
        and len(themes) == 3 == len(categories)
        and result_ends_turn("mcp__omnigent__deck_new", json.dumps(out))
        and out["written"] is False
        and not (workspace / "d.deck.html").exists()
    )


async def test_named_is_verified_by_the_persons_own_words(workspace: Path) -> None:
    assert _built(await _new("named", "nord", ctx([user("Make a deck from it, use Nord")])))
    (workspace / "d.deck.html").unlink()
    # a mood counts when it fits the theme
    assert _built(await _new("named", "tokyo-night", ctx([user("something DARK please")])))
    (workspace / "d.deck.html").unlink()
    # the live failure: the name is only in earlier decks, not in the person's message
    items = [user("Make a Corporate Clean deck about Q2"), user("now make a 5-slide deck from it")]
    out = await _new("named", "corporate-clean", ctx(items))
    assert _is_card(out, workspace) and "does not name" in out["note"]
    # a mood that does not fit this theme
    assert _is_card(await _new("named", "bauhaus", ctx([user("make it dark")])), workspace)


async def test_picked_needs_the_answered_card_and_that_exact_theme(workspace: Path) -> None:
    offered = [("Corporate Clean", "corporate-clean"), ("Cartesian", "cartesian")]
    offered.append(("Nord", "nord"))
    answered = [user("make a deck"), card_call(), card_output(offered), user("Cartesian")]
    assert _built(await _new("picked", "cartesian", ctx(answered)))
    (workspace / "d.deck.html").unlink()
    # the wrong theme for the pick
    out = await _new("picked", "corporate-clean", ctx(answered))
    assert _is_card(out, workspace) and "does not pick" in out["note"]
    # no card before the latest message (an older answered card does not count)
    stale = [*answered, user("now another deck")]
    assert _is_card(await _new("picked", "cartesian", ctx(stale)), workspace)
    # a runtime notice after the answer is not the person's message
    notice = [*answered, user("[System: helper finished]", is_system_notice=True)]
    assert _built(await _new("picked", "cartesian", ctx(notice)))
    (workspace / "d.deck.html").unlink()
    # deck_new's own card counts too
    own = [user("a deck"), card_call("deck_new"), card_output(offered), user("Cartesian")]
    assert _built(await _new("picked", "cartesian", ctx(own)))
    (workspace / "d.deck.html").unlink()
    # a card-shaped output from a tool the model controls (shell) is not a card
    faked = [user("a deck"), card_call("sys_os_shell"), card_output(offered), user("Cartesian")]
    assert _is_card(await _new("picked", "cartesian", ctx(faked)), workspace)


async def test_preference_needs_an_active_claim_naming_the_theme(workspace: Path) -> None:
    claims = [
        {"text": "Prefers the Nord theme for decks", "status": "active", "explicitness": "stated"}
    ]
    assert _built(await _new("preference", "nord", ctx([user("a deck")], claims=claims)))
    (workspace / "d.deck.html").unlink()
    # the live failure: "your usual Corporate Clean look" with no claim about it
    out = await _new("preference", "corporate-clean", ctx([user("a deck")], claims=claims))
    assert _is_card(out, workspace) and "preference" in out["note"]
    assert _is_card(await _new("preference", "nord", ctx([user("a deck")])), workspace)
    expired = [{"text": "Prefers Nord for decks", "status": "expired", "explicitness": "stated"}]
    assert _is_card(await _new("preference", "nord", ctx([user("x")], claims=expired)), workspace)


async def test_you_choose_needs_the_person_to_hand_over_the_choice(workspace: Path) -> None:
    assert _built(await _new("you_choose", "minimal-white", ctx([user("A deck. Your call!")])))
    (workspace / "d.deck.html").unlink()
    assert _is_card(await _new("you_choose", "minimal-white", ctx([user("a deck")])), workspace)


async def test_background_only_for_work_no_person_started(workspace: Path) -> None:
    assert _built(await _new("background", "swiss-grid", helper_ctx()))
    (workspace / "d.deck.html").unlink()
    fired = ctx(root_labels={SCHEDULED_FIRE_LABEL_KEY: "task1"})  # a scheduled fire's own chat
    assert _built(await _new("background", "swiss-grid", fired))
    (workspace / "d.deck.html").unlink()
    assert _is_card(await _new("background", "swiss-grid", ctx([user("a deck")])), workspace)


async def test_a_helper_is_checked_against_the_chat_that_started_it(workspace: Path) -> None:
    """The live bypass: the Muse delegated, and its Helper built in a look nobody chose."""
    asked = [user("Make a 5-slide deck about our 2026 sales from sales_2026.csv")]
    for look_from in ("preference", "background", "named", None):
        out = await _new(look_from, "corporate-clean", ctx(asked, helper={}))
        assert out["error"].startswith(HELPER_REFUSAL), look_from
        assert "card" not in out and not (workspace / "d.deck.html").exists()
    # the Muse asked first and passed the pick in the Brief: the chat's answered card backs it
    offered = [("Corporate Clean", "corporate-clean"), ("Cartesian", "cartesian")]
    picked = [*asked, card_call(), card_output(offered), user("Cartesian")]
    assert _built(await _new("picked", "cartesian", ctx(picked, helper={})))
    (workspace / "d.deck.html").unlink()
    out = await _new("picked", "corporate-clean", ctx(picked, helper={}))
    assert out["error"].startswith(HELPER_REFUSAL)
    named = [user("A deck about 2026 sales, in Nord")]
    assert _built(await _new("named", "nord", ctx(named, helper={})))


async def test_missing_ask_or_unknown_look_from_shows_the_card(workspace: Path) -> None:
    items = [user("a deck about our hiring")]
    for look_from in (None, "ask", "default"):
        assert _is_card(await _new(look_from, "corporate-clean", ctx(items)), workspace)
    # even the menu call (no slides) asks first
    menu = json.loads(
        await handle_authoring_tool(
            "deck_new",
            {"path": "d.deck.html", "template": "nord", "look_from": "ask", "title": "T"},
            ctx(items),
        )
    )
    assert menu["card"] == "ask"
    # no server: nothing can be checked, so the person is asked
    assert _is_card(await _new("named", "nord", None), workspace)


def test_the_card_offers_three_categories_fitting_the_request() -> None:
    assert pick_three("")[0] == kit.DEFAULT_THEME
    assert "nord" in pick_three("a dark deck, maybe Nord")
    assert "pitch-deck-vc" in pick_three("seed round for investors")
    for hint in ("", "dark", "editorial story", "playful kids"):
        assert len({kit.templates()[t].category for t in pick_three(hint)}) == 3


def test_the_card_shows_in_the_transcript_and_ends_the_turn() -> None:
    card = json.loads(json.dumps({"type": "card", "card": "ask", "fallback": "Which look?"}))
    card["data"] = {"question": "Which look?", "options": [{"id": "opt-1", "label": "Nord"}]}
    call = {"type": "function_call", "id": "f1", "name": "mcp__omnigent__deck_new"}
    late = {"id": "a1", "type": "message", "role": "assistant"}
    items = [
        user("deck", id="u1"),
        call | {"call_id": "c9", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c9", "output": json.dumps(card)},
        late | {"content": [{"type": "output_text", "text": "late"}]},
    ]
    messages = project_items(items)
    assert messages[1]["blocks"][0]["card"]["card"] == "ask"
    assert all(m["id"] != "a1" for m in messages)  # text after the card is dropped


async def test_an_inferred_preference_through_the_runner_dispatch_shows_the_card(
    workspace: Path,
) -> None:
    """The live failure: a noticed "prefers Corporate Clean" claim (learned from decks the Muse
    styled itself) let deck_new build. Same path as the runner: the decks feature handler."""
    noticed = {
        "text": "Prefers the Corporate Clean look for decks",
        "status": "active",
        "explicitness": "inferred",
        "person_authored": False,
    }
    call_ctx = ctx([user("Now make a 5-slide deck from it")], claims=[noticed])
    args = {
        "path": "your_files/sales-2026.deck.html",
        "template": "corporate-clean",
        "look_from": "preference",
        "title": "Sales 2026",
    }
    for extra in ({}, {"slides": SAMPLE}):  # the layout-menu call and the writing call
        out = json.loads(await handle_deck_tool(call_ctx, {**args, **extra}))
        assert out["card"] == "ask" and out["written"] is False
    assert not (workspace / "your_files").exists()
    edited = {**noticed, "person_authored": True}
    menu = json.loads(await handle_deck_tool(ctx([user("x")], claims=[edited]), args))
    assert "layouts" in menu
