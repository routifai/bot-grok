"""Deck source patches: exact spans, untouched bytes, refusals."""

from __future__ import annotations

import pytest

from omnigent.superchat.decks import kit
from omnigent.superchat.decks.patches import (
    AmbiguousEdit,
    DuplicateElement,
    InvalidPatch,
    RemoveElement,
    SetAttributes,
    SetFullSource,
    SetStyle,
    SetText,
    SetTheme,
    apply_patches,
)

DOC = """<!doctype html>
<html><head><style>.a{color:red}</style></head><body>
<div data-nova-id="frame"><p data-nova-id="frame-note">chrome</p></div>
<section class="slide active" data-screen-label="01 Cover" data-nova-id="s1">
  <h1 data-nova-id="title" style="font-size: 64px; color: #111">Hello &amp; <b>x</b></h1>
  <h2 data-nova-id="sub"><span data-nova-id="sub-in" class="k">Sub</span></h2>
  <p data-nova-id="lines">one<br>two</p>
  <a data-nova-id="link" href="https://a.test">go</a>
  <img data-nova-id="pic" src="data:image/png;base64,AA==">
</section>
<section class="slide" data-screen-label="02 Next" data-nova-id="s2">
  <p data-nova-id="body" style='margin:0'>Body &lt;1&gt;</p>
</section>
</body></html>
"""


def run(patches, doc: str = DOC) -> tuple[str, str]:
    out, summary = apply_patches(doc.encode(), patches)
    return out.decode(), summary


def assert_only_span_changed(old: str, new: str, old_span: str, new_span: str) -> None:
    i = old.index(old_span)
    assert new[:i] == old[:i]
    assert new[i : i + len(new_span)] == new_span
    assert new[i + len(new_span) :] == old[i + len(old_span) :]


def test_set_text_replaces_only_the_inner_span() -> None:
    doc = DOC.replace("Hello &amp; <b>x</b>", "Hello")
    new, summary = run([SetText(kind="set-text", id="title", text="A < B & C")], doc)
    assert_only_span_changed(doc, new, ">Hello<", ">A &lt; B &amp; C<")
    assert summary == 'slide 1 title "Hello" → "A < B & C"'


def test_set_text_through_single_wrapper_keeps_the_run() -> None:
    new, _ = run([SetText(kind="set-text", id="sub", text="Other")])
    assert '<h2 data-nova-id="sub"><span data-nova-id="sub-in" class="k">Other</span></h2>' in new


def test_set_text_with_line_breaks_keeps_br() -> None:
    new, _ = run([SetText(kind="set-text", id="lines", text="a\nb\nc")])
    assert '<p data-nova-id="lines">a<br>b<br>c</p>' in new


def test_set_text_mixed_content_is_refused() -> None:
    with pytest.raises(AmbiguousEdit, match="ask Nova instead"):
        run([SetText(kind="set-text", id="title", text="x")])


def test_set_text_on_void_element_is_invalid() -> None:
    with pytest.raises(InvalidPatch):
        run([SetText(kind="set-text", id="pic", text="x")])


def test_set_style_merges_in_place_and_keeps_other_bytes() -> None:
    new, summary = run([SetStyle(kind="set-style", id="title", style={"font-size": "72px"})])
    assert 'style="font-size: 72px; color: #111;"' in new
    assert summary == "slide 1 title font-size 64px→72px"
    old_tag = 'style="font-size: 64px; color: #111"'
    assert_only_span_changed(DOC, new, old_tag, 'style="font-size: 72px; color: #111;"')


def test_set_style_adds_attribute_and_removes_with_null() -> None:
    new, _ = run([SetStyle(kind="set-style", id="sub", style={"opacity": "0.5"})])
    assert '<h2 data-nova-id="sub" style="opacity: 0.5;">' in new
    new2, _ = run([SetStyle(kind="set-style", id="body", style={"margin": None})])
    assert '<p data-nova-id="body">Body' in new2


@pytest.mark.parametrize(
    "prop,value",
    [
        ("color", "red; background: url(x)"),
        ("color", "url(https://x.test/a.png)"),
        ("width", "expression(alert(1))"),
        ("color", "red}</style>"),
        ("Color", "red"),
        ("behavior", "x"),
        ("color", "a\nb"),
    ],
)
def test_set_style_rejects_bad_values(prop: str, value: str) -> None:
    with pytest.raises(InvalidPatch):
        run([SetStyle(kind="set-style", id="title", style={prop: value})])


def test_set_attributes_href_and_alt() -> None:
    new, _ = run([SetAttributes(kind="set-attributes", id="link", attributes={"href": "#two"})])
    assert '<a data-nova-id="link" href="#two">go</a>' in new
    new, _ = run([SetAttributes(kind="set-attributes", id="pic", attributes={"alt": 'A "pic"'})])
    assert 'alt="A &quot;pic&quot;">' in new
    new, _ = run([SetAttributes(kind="set-attributes", id="link", attributes={"href": None})])
    assert '<a data-nova-id="link">go</a>' in new


@pytest.mark.parametrize(
    "value", ["javascript:alert(1)", "data:text/html,x", "//evil.test", "x y"]
)
def test_set_attributes_rejects_bad_href(value: str) -> None:
    with pytest.raises(InvalidPatch):
        run([SetAttributes(kind="set-attributes", id="link", attributes={"href": value})])


def test_set_attributes_wrong_element() -> None:
    with pytest.raises(InvalidPatch):
        run([SetAttributes(kind="set-attributes", id="title", attributes={"href": "#a"})])


def test_remove_element_takes_its_line() -> None:
    new, summary = run([RemoveElement(kind="remove-element", id="lines")])
    assert '<p data-nova-id="lines">' not in new
    assert new.replace('  <p data-nova-id="lines">one<br>two</p>\n', "") == DOC.replace(
        '  <p data-nova-id="lines">one<br>two</p>\n', ""
    )
    assert summary == "slide 1 lines: removed"


def test_cannot_remove_the_last_slide() -> None:
    doc = DOC.replace("s2", "gone")
    one = doc[: doc.index('<section class="slide" data-screen')] + "</body></html>"
    with pytest.raises(AmbiguousEdit):
        run([RemoveElement(kind="remove-element", id="s1")], one)


def test_duplicate_element_gets_unique_ids() -> None:
    new, summary = run([DuplicateElement(kind="duplicate-element", id="body")])
    assert 'data-nova-id="body-copy"' in new and new.count('data-nova-id="body"') == 1
    assert summary == "slide 2 body: duplicated"
    again, _ = apply_patches(new.encode(), [DuplicateElement(kind="duplicate-element", id="body")])
    assert b'data-nova-id="body-copy-2"' in again


def test_duplicate_slide_renames_inner_ids_and_drops_active() -> None:
    new, _ = run([DuplicateElement(kind="duplicate-element", id="s1")])
    assert 'data-nova-id="s1-copy"' in new and 'data-nova-id="title-copy"' in new
    copy = new[new.index('data-nova-id="s1-copy"') - 60 :]
    assert 'class="slide" data-screen-label="01 Cover" data-nova-id="s1-copy"' in copy


def test_refuses_duplicate_ids_unknown_ids_and_the_frame() -> None:
    twice = DOC.replace('data-nova-id="body"', 'data-nova-id="title"')
    with pytest.raises(AmbiguousEdit, match="used by 2"):
        run([SetStyle(kind="set-style", id="title", style={"opacity": "1"})], twice)
    with pytest.raises(AmbiguousEdit, match="no element"):
        run([RemoveElement(kind="remove-element", id="nope")])
    with pytest.raises(AmbiguousEdit, match="deck frame"):
        run([RemoveElement(kind="remove-element", id="frame-note")])


def test_refuses_unclosed_markup() -> None:
    doc = DOC.replace(
        "<p data-nova-id=\"body\" style='margin:0'>Body &lt;1&gt;</p>",
        '<p data-nova-id="body">Body',
    )
    with pytest.raises(AmbiguousEdit, match="not closed cleanly"):
        run([SetText(kind="set-text", id="body", text="x")], doc)


def test_full_source_roundtrip_and_guards() -> None:
    new, _ = run([SetFullSource(kind="set-full-source", source=DOC.replace("Sub", "Zed"))])
    assert "Zed" in new
    with pytest.raises(InvalidPatch):
        run([SetFullSource(kind="set-full-source", source="  ")])
    with pytest.raises(InvalidPatch, match="scripts"):
        run([SetFullSource(kind="set-full-source", source=DOC + "<script>x()</script>")])
    with pytest.raises(AmbiguousEdit):
        run([SetFullSource(kind="set-full-source", source=DOC.replace('"s2"', '"s1"'))])


def test_patches_apply_in_order_and_summaries_join() -> None:
    new, summary = run(
        [
            SetText(kind="set-text", id="body", text="Hi"),
            SetStyle(kind="set-style", id="body", style={"margin": "4px"}),
        ]
    )
    assert "<p data-nova-id=\"body\" style='margin:0'>" not in new
    assert 'style="margin: 4px;"' in new and ">Hi<" in new
    assert summary.count("; ") == 1


def test_real_kit_deck_only_the_span_changes() -> None:
    deck = kit.build_deck("blue-professional", "T").encode()
    out, summary = apply_patches(
        deck, [SetText(kind="set-text", id="cover-title", text="Q3 plan")]
    )
    start = deck.index(b'data-nova-id="cover-title"')
    open_end = deck.index(b">", start) + 1
    close = deck.index(b"</", open_end)
    assert out[:open_end] == deck[:open_end]
    assert out[open_end : open_end + 7] == b"Q3 plan"
    assert out[open_end + 7 :] == deck[close:]
    assert 'slide 1 cover-title "' in summary
    # the font block and framework survive byte for byte
    assert out.count(b"@font-face") == deck.count(b"@font-face")


def test_set_style_summary_uses_the_editor_s_before_values() -> None:
    """A property with no inline declaration is worded from the editor's before value."""
    out, summary = run(
        [
            SetStyle(
                kind="set-style",
                id="body",
                style={"font-size": "72px"},
                before={"font-size": "64px"},
            )
        ]
    )
    assert "font-size 64px→72px" in summary
    assert "before" not in out


SAMPLE = (kit.KIT_DIR / "sample-slides.html").read_text("utf-8")


def _slides(document: str) -> str:
    return document[document.index(kit.SLOTS_OPEN) : document.index(kit.SLOTS_CLOSE)]


def test_set_theme_swaps_tokens_css_and_fonts_and_leaves_the_slides_alone() -> None:
    deck = kit.build_deck("corporate-clean", "Q3", SAMPLE)
    new, summary = run([SetTheme(kind="set-theme", theme="nord")], deck)
    assert new == kit.build_deck("nord", "Q3", SAMPLE)
    assert _slides(new) == _slides(deck)
    assert kit.deck_theme_id(new) == "nord"
    assert summary == "switched the theme to Nord (was Corporate Clean)"


def test_set_theme_round_trips_and_keeps_hand_edits_to_slides() -> None:
    deck = kit.build_deck("minimal-white", "Q3", SAMPLE)
    edited, _ = run([SetText(kind="set-text", id="cover-title", text="Edited")], deck)
    there, _ = run([SetTheme(kind="set-theme", theme="tokyo-night")], edited)
    back, _ = run([SetTheme(kind="set-theme", theme="minimal-white")], there)
    assert back == edited


def test_set_theme_to_the_current_theme_changes_nothing() -> None:
    deck = kit.build_deck("nord", "Q3", SAMPLE)
    new, summary = run([SetTheme(kind="set-theme", theme="nord")], deck)
    assert new == deck and summary == ""


def test_set_theme_refuses_unknown_themes_and_decks_the_kit_did_not_build() -> None:
    deck = kit.build_deck("nord", "Q3", SAMPLE)
    with pytest.raises(InvalidPatch):
        run([SetTheme(kind="set-theme", theme="nope")], deck)
    with pytest.raises(AmbiguousEdit, match="ask Nova"):
        run([SetTheme(kind="set-theme", theme="nord")], DOC)


def _with_custom(deck: str) -> str:
    """The deck as a person or Nova leaves it: a custom rule, token and a theme-token override."""
    own = (
        "    .brand-card { border: 3px solid var(--brand); }\n"
        "    :root { --brand: #123456; --accent: #ff00aa; }\n"
    )
    marker = "    /* /nova:theme */\n"
    return deck.replace(marker, marker + own, 1)


def test_set_theme_keeps_the_decks_own_css_tokens_and_overrides() -> None:
    deck = _with_custom(kit.build_deck("corporate-clean", "Q3", SAMPLE))
    assert ".brand-card" in deck
    new, _ = run([SetTheme(kind="set-theme", theme="nord")], deck)
    assert ".brand-card { border: 3px solid var(--brand); }" in new
    assert ":root { --brand: #123456; --accent: #ff00aa; }" in new
    assert kit.deck_theme_id(new) == "nord"
    # the kit's regions are the new theme's, and the deck's own lines stayed after them
    assert new == _with_custom(kit.build_deck("nord", "Q3", SAMPLE))
    back, _ = run([SetTheme(kind="set-theme", theme="corporate-clean")], new)
    assert back == deck


def test_every_theme_round_trips_to_every_other_for_an_unmodified_deck() -> None:
    ids = sorted(kit.templates())
    base = kit.build_deck(ids[0], "Q3", SAMPLE)
    for source in ids:
        deck = kit.build_deck(source, "Q3", SAMPLE)
        for target in ids:
            new, _ = run([SetTheme(kind="set-theme", theme=target)], deck)
            assert new == kit.build_deck(target, "Q3", SAMPLE)
    assert run([SetTheme(kind="set-theme", theme=ids[0])], base)[0] == base


def _legacy(deck: str, theme: str) -> str:
    """A deck as saved before the markers: one whole :root and one whole style block."""
    t = kit.templates()[theme]
    deck = deck.replace(kit._tokens_region(t), kit._tokens_text(t), 1)
    head = f"    /* {t.name} \u00b7 layout vocabulary and theme */\n"
    old = deck[deck.index("  <style>\n    /* nova:theme") :]
    old = old[: old.index("  </style>") + len("  </style>")]
    return deck.replace(old, "  <style>\n" + head + kit._css_text(t) + "\n  </style>", 1)


def test_a_deck_saved_before_the_markers_is_adopted_without_losing_anything() -> None:
    legacy = _legacy(kit.build_deck("tokyo-night", "Q3", SAMPLE), "tokyo-night")
    assert "nova:theme id=" not in legacy and kit.deck_theme_id(legacy) == "tokyo-night"
    new, _ = run([SetTheme(kind="set-theme", theme="nord")], legacy)
    assert _norm(new) == _norm(
        kit.build_deck("nord", "Q3", SAMPLE).replace(kit._DECK_HINT + "\n", "")
    )
    # extras the deck added around the kit's text survive
    css = kit._css_text(kit.templates()["tokyo-night"])
    legacy_extra = legacy.replace(css, css + "\n    .mine { color: red; }", 1)
    assert ".mine" in legacy_extra
    kept, _ = run([SetTheme(kind="set-theme", theme="nord")], legacy_extra)
    assert ".mine { color: red; }" in kept


def _norm(deck: str) -> str:
    """The deck minus the framework's guidance comment, which older decks word differently."""
    import re

    return re.sub(
        r"Edit only inside the second <style>.*?bodies\."
        r"|Write per-deck CSS.*?keeps everything outside\)\.",
        "",
        deck,
        flags=re.S,
    )


def _fragment_line(theme: str) -> str:
    """A declaration line inside one of the theme CSS's multi-line rules."""
    css = kit._css_text(kit.templates()[theme])
    return next(
        line for line in css.splitlines() if line.startswith("  ") and line.rstrip().endswith(";")
    )


def test_a_legacy_block_edited_inside_in_a_way_that_cannot_be_kept_is_refused() -> None:
    legacy = _legacy(kit.build_deck("nord", "Q3", SAMPLE), "nord")
    line = _fragment_line("nord")
    edited = legacy.replace(line, line.replace(":", ": 1px /* edited */ +", 1), 1)
    assert edited != legacy
    with pytest.raises(AmbiguousEdit, match="ask Nova"):
        run([SetTheme(kind="set-theme", theme="tokyo-night")], edited)


def test_a_region_edited_between_its_markers_is_refused_and_the_deck_is_unchanged() -> None:
    deck = kit.build_deck("blue-professional", "Q3", SAMPLE)
    tokens = deck.replace("--accent: #1e2bfa;", "--accent: #ff0000;", 1)
    # the round-3 repro: a multi-line rule written inside the theme region
    rule = deck.replace(
        "\n.kicker {", "\n.hero {\n  color: red;\n}\n.badge { color: blue; }\n.kicker {", 1
    )
    inside = deck.replace(
        "    /* /nova:theme */", "    .mine { color: red; }\n    /* /nova:theme */", 1
    )
    for edited in (tokens, rule, inside):
        assert edited != deck
        with pytest.raises(AmbiguousEdit, match="ask Nova"):
            run([SetTheme(kind="set-theme", theme="magazine-mono")], edited)


def test_nested_or_repeated_markers_are_refused() -> None:
    deck = kit.build_deck("nord", "Q3", SAMPLE)
    start = "    /* nova:theme id=nord"
    nested = deck.replace(start, f"{start} sha=000000000000 \u00b7 Nord */\n{start}", 1)
    with pytest.raises(AmbiguousEdit):
        run([SetTheme(kind="set-theme", theme="tokyo-night")], nested)


def test_regions_without_a_hash_are_still_swapped() -> None:
    import re

    deck = kit.build_deck("nord", "Q3", SAMPLE)
    plain = re.sub(r" sha=[0-9a-f]{12}", "", deck)
    new, _ = run([SetTheme(kind="set-theme", theme="tokyo-night")], plain)
    assert new == kit.build_deck("tokyo-night", "Q3", SAMPLE)


def test_a_marker_lookalike_in_a_slide_is_not_the_decks_theme() -> None:
    deck = kit.build_deck("nord", "Q3", SAMPLE)
    fake = deck.replace("</body>", "<!-- /* nova:theme id=bauhaus */ --></body>", 1)
    assert kit.deck_theme_id(fake) == "nord"


def _old_kit(rev: str, tmp: str):
    """The kit as released at git ``rev``, imported from ``git archive`` (None without git)."""
    import importlib.util
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[5]
    base = "engine/omnigent/omnigent/superchat/decks"
    done = subprocess.run(
        f"git archive {rev} {base} | tar -x -C {tmp}",
        shell=True,
        cwd=root,
        capture_output=True,
    )
    path = Path(tmp) / base / "kit.py"
    if done.returncode != 0 or not path.is_file():
        return None
    name = f"oldkit_{rev}"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[name] = module
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


@pytest.mark.parametrize("rev", ["d46b2965", "9a0bb8bc"])
def test_decks_built_by_every_released_kit_can_switch_theme(
    rev: str, tmp_path_factory: pytest.TempPathFactory
) -> None:
    old = _old_kit(rev, str(tmp_path_factory.mktemp(rev)))
    if old is None:
        pytest.skip(f"git history for {rev} is not available")
    fresh = _norm(kit.build_deck("nord", "Q3", SAMPLE).replace(kit._DECK_HINT + "\n", ""))
    for theme in old.templates():
        deck = old.build_deck(theme, "Q3", SAMPLE)
        assert kit.deck_theme_id(deck) == theme
        new, _ = run([SetTheme(kind="set-theme", theme="nord")], deck)
        assert kit.deck_theme_id(new) == "nord"
        assert _slides(new) == _slides(deck)
        if rev != "d46b2965":  # the first kit had no chart runtime to compare
            assert _norm(new) == fresh
        # a custom rule the old deck had survives the adoption
        block = kit._LEGACY_STYLE_RE.search(deck).group(0)  # type: ignore[union-attr]
        extra = block[: -len("\n  </style>")] + "\n    .mine { color: red; }\n  </style>"
        mine = deck.replace(block, extra, 1)
        assert mine != deck
        kept, _ = run([SetTheme(kind="set-theme", theme="nord")], mine)
        assert ".mine { color: red; }" in kept


def test_every_released_block_text_is_in_the_shipped_table() -> None:
    table = kit._legacy_kits()
    assert set(table) == {"blue-professional", "editorial-tri-tone", "magazine-mono"}
    assert all(len(texts) >= 2 for texts in table.values())
    for theme, texts in table.items():
        for text in texts:
            head = f"    /* {kit.templates()[theme].name} \u00b7 layout vocabulary and theme */\n"
            deck = kit.build_deck(theme, "Q3", SAMPLE)
            legacy = _legacy(deck, theme)
            old_block = legacy.replace(kit._css_text(kit.templates()[theme]), text["css"], 1)
            assert head + text["css"] in old_block
            new, _ = run([SetTheme(kind="set-theme", theme="nord")], old_block)
            assert kit.deck_theme_id(new) == "nord"
