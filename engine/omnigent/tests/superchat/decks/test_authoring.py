"""Decks: the kit (templates, assembly, static checks) and the deck_new / deck_check handlers."""

from __future__ import annotations

import json
import re
import stat
from pathlib import Path

import pytest

from omnigent.superchat.decks import kit
from omnigent.superchat.decks.authoring import handle_authoring_tool
from omnigent.superchat.decks.feature import DECKS_FEATURE
from omnigent.superchat.decks.handlers import HELPER_ENV
from omnigent.superchat.decks.tools import DeckCheckTool, DeckNewTool

SAMPLE = (kit.KIT_DIR / "sample-slides.html").read_text("utf-8")


def _labels() -> dict[str, str]:
    from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE

    return {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}


def _slides_in(deck: str) -> str:
    return deck.split(kit.SLOTS_OPEN, 1)[1].split(kit.SLOTS_CLOSE, 1)[0]


def test_three_templates_with_licenses_and_embeddable_fonts() -> None:
    assert set(kit.templates()) == {"blue-professional", "editorial-tri-tone", "magazine-mono"}
    for template in kit.templates().values():
        assert (template.directory / "LICENSE").read_text("utf-8").startswith("MIT License")
        for font in template.fonts:
            assert (template.directory / "fonts" / str(font["file"])).stat().st_size > 10_000
            assert (template.directory / "fonts" / str(font["license"])).read_text("utf-8").strip()


@pytest.mark.parametrize("template", sorted(kit.templates()))
def test_assembled_deck_keeps_the_framework_and_embeds_fonts(template: str) -> None:
    deck = kit.build_deck(template, "Q3 <review> & plans", SAMPLE)
    assert deck.startswith("<!doctype html>")
    assert '<html lang="en" data-nova-deck-protocol="1">' in deck
    assert "<title>Q3 &lt;review&gt; &amp; plans</title>" in deck
    # the framework: one stage, print rules, protocol, export-aware fit()
    assert 'class="deck-stage" id="deck-stage"' in deck and "@media print" in deck
    assert "nova:slide-state" in deck and "data-nova-export" in deck
    # the theme and slides went into their slots; no slot comment is left behind
    assert "SLOT:" not in deck.replace("SLOT: theme tokens", "")
    assert kit.SLOTS_OPEN in deck and kit.SLOTS_CLOSE in deck
    assert _slides_in(deck).count('<section class="slide') == 8
    # fonts are data URIs (the viewer's CSP blocks remote fonts); nothing is fetched from the web
    assert "data:font/ttf;base64," in deck
    assert not re.search(r"https?://fonts\.", deck)
    assert not kit._EXTERNAL_RE.search(deck.split("</style>")[0].split("<style>", 1)[-1] + SAMPLE)


def test_sample_slides_pass_the_static_checks_and_every_text_block_has_an_id() -> None:
    assert kit.check_slides(SAMPLE) == ([], [])
    ids = kit._ID_RE.findall(SAMPLE)
    assert len(ids) == len(set(ids)) > 50


def test_static_checks_report_what_a_slide_must_fix() -> None:
    errors, warnings = kit.check_slides(
        '<section class="slide t-a"><h1>No id</h1><img src="https://x.test/a.png">'
        "<script>1</script></section>"
    )
    joined = " ".join(errors)
    assert "data-screen-label" in joined and "data-nova-id" in joined
    assert "<script>" in joined and "web" in joined
    assert warnings and "active" in warnings[0]
    dup, _ = kit.check_slides(
        '<section class="slide active" data-screen-label="01 A" data-nova-id="a">'
        '<p data-nova-id="x">1</p><p data-nova-id="x">2</p>'
        '<p data-nova-id="Bad_Id">3</p></section>'
    )
    assert any('"x" is used more than once' in e for e in dup)
    assert any("Bad_Id" in e for e in dup)
    assert kit.check_slides("<p>nothing</p>")[0]


def test_unknown_template_is_refused() -> None:
    with pytest.raises(kit.KitError):
        kit.build_deck("nope", "x", SAMPLE)


def test_tools_are_offered_to_the_muse_only() -> None:
    names = {t.name() for t in DECKS_FEATURE.tools(_labels(), None)}  # type: ignore[arg-type]
    assert names == {"deck_new", "deck_check", "deck_export"}
    assert DECKS_FEATURE.tools({}, None) == []  # type: ignore[arg-type]
    new = DeckNewTool().get_schema()["function"]["parameters"]
    assert new["required"] == ["path", "template", "title"]
    assert new["properties"]["template"]["enum"] == list(kit.templates())
    assert DeckCheckTool().get_schema()["function"]["parameters"]["required"] == ["path"]
    for name in ("deck_new", "deck_check"):
        assert name in DECKS_FEATURE.handlers


def _fake_helper(tmp_path: Path, issues: list[dict[str, object]] | None) -> Path:
    """A helper that answers `--format lint` with `issues` (or fails when `issues` is None)."""
    script = tmp_path / "fake-helper"
    if issues is None:
        body = 'print(\'{"ok": false, "error": "Chromium is not installed on this computer"}\')'
    else:
        body = f"print({json.dumps(json.dumps({'ok': True, 'slides': 8, 'issues': issues}))})"
    script.write_text(f"#!/usr/bin/env python3\n{body}\n")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


@pytest.fixture()
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(root))
    monkeypatch.setenv(HELPER_ENV, str(_fake_helper(tmp_path, [])))
    return root


async def test_deck_new_writes_the_deck_and_reports_a_clean_layout(workspace: Path) -> None:
    out = json.loads(
        await handle_authoring_tool(
            "deck_new",
            {
                "path": "your_files/q3.deck.html",
                "template": "blue-professional",
                "title": "Q3",
                "slides": SAMPLE,
            },
        )
    )
    assert out["ok"] is True and out["written"] is True and out["layout_checked"] is True
    target = workspace / "your_files" / "q3.deck.html"
    assert out["path"] == str(target.resolve())
    assert _slides_in(target.read_text("utf-8")).count('<section class="slide') == 8
    assert "artifact_save" in out["next"]


async def test_deck_new_without_slides_returns_the_layout_menu_and_writes_nothing(
    workspace: Path,
) -> None:
    out = json.loads(
        await handle_authoring_tool(
            "deck_new", {"path": "d.deck.html", "template": "magazine-mono", "title": "T"}
        )
    )
    assert out["written"] is False and "l-statement" in out["layouts"]
    assert not (workspace / "d.deck.html").exists()


async def test_deck_new_refuses_bad_input_and_never_overwrites(workspace: Path) -> None:
    base = {"template": "magazine-mono", "title": "T", "slides": SAMPLE}
    bad_name = json.loads(await handle_authoring_tool("deck_new", {**base, "path": "d.html"}))
    assert ".deck.html" in bad_name["error"]
    outside = json.loads(
        await handle_authoring_tool("deck_new", {**base, "path": "/etc/x.deck.html"})
    )
    assert "workspace" in outside["error"]
    broken = json.loads(
        await handle_authoring_tool(
            "deck_new", {**base, "path": "d.deck.html", "slides": "<p>x</p>"}
        )
    )
    assert broken["written"] is False and broken["errors"]
    assert not (workspace / "d.deck.html").exists()
    first = json.loads(await handle_authoring_tool("deck_new", {**base, "path": "d.deck.html"}))
    assert first["written"] is True
    again = json.loads(await handle_authoring_tool("deck_new", {**base, "path": "d.deck.html"}))
    assert "already exists" in again["error"]


async def test_deck_check_lists_layout_errors_with_slide_and_id(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (workspace / "d.deck.html").write_text(kit.build_deck("magazine-mono", "T", SAMPLE), "utf-8")
    issues = [
        {
            "slide": 2,
            "label": "02 Why",
            "id": "why-statement",
            "severity": "error",
            "code": "footer-rail",
            "message": "This content runs into the footer band; move it up or split the slide.",
        },
        {
            "slide": 3,
            "label": "03 Ideas",
            "id": "",
            "severity": "warning",
            "code": "small-text",
            "message": "Text is 14px.",
        },
        {
            "slide": 1,
            "label": "01 Cover",
            "id": "glow",
            "severity": "note",
            "code": "picture-layer",
            "message": "gradient becomes a picture layer.",
        },
    ]
    monkeypatch.setenv(HELPER_ENV, str(_fake_helper(tmp_path, issues)))
    out = json.loads(await handle_authoring_tool("deck_check", {"path": "d.deck.html"}))
    assert out["ok"] is False
    assert out["errors"] == [
        "Slide 2 (Why) [why-statement]: This content runs into the footer band; "
        "move it up or split the slide."
    ]
    assert out["warnings"] == ["Slide 3 (Ideas): Text is 14px."]
    assert out["notes"][0].startswith("Slide 1 (Cover) [glow]")
    assert "deck_check again" in out["next"]


async def test_deck_check_still_checks_structure_when_chromium_is_missing(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = kit.build_deck("magazine-mono", "T", SAMPLE).replace(
        ' data-nova-id="why-statement"', ""
    )
    broken = broken.replace('data-nova-id="why"', 'data-nova-id="cover"')
    (workspace / "d.deck.html").write_text(broken, "utf-8")
    monkeypatch.setenv(HELPER_ENV, str(_fake_helper(tmp_path, None)))
    out = json.loads(await handle_authoring_tool("deck_check", {"path": "d.deck.html"}))
    assert out["layout_checked"] is False and "Chromium" in out["layout_note"]
    assert out["ok"] is False and any("more than once" in e for e in out["errors"])


async def test_deck_check_unknown_file(workspace: Path) -> None:
    out = json.loads(await handle_authoring_tool("deck_check", {"path": "missing.deck.html"}))
    assert "not found" in out["error"].lower()
