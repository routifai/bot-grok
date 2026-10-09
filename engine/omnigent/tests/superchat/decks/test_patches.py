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
