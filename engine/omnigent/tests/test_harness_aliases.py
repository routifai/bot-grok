"""Tests for omnigent.harness_aliases."""

from __future__ import annotations

import pytest

from omnigent.harness_aliases import (
    canonicalize_harness,
    is_native_harness,
    native_terminal_name,
)


@pytest.mark.parametrize(
    "alias,canonical",
    [
        ("claude", "claude-sdk"),
        ("native-claude", "claude-native"),
        # Canonical names pass through unchanged.
        ("claude-sdk", "claude-sdk"),
        ("claude-native", "claude-native"),
        ("pi", "pi"),
        # Unknown names return unchanged so callers keep their own errors.
        ("bogus", "bogus"),
        (None, None),
    ],
)
def test_canonicalize_harness(alias: str | None, canonical: str | None) -> None:
    """Alias spellings map to canonical ids; everything else passes through."""
    assert canonicalize_harness(alias) == canonical


@pytest.mark.parametrize(
    "harness,expected",
    [
        # The canonical native spelling and its reversed form.
        ("claude-native", True),
        ("native-claude", True),
        # SDK harnesses are NOT native — they replay the Omnigent
        # transcript and don't own an on-disk runtime transcript. A
        # regression that classified these as native would wrongly route a
        # fork into the native-rebuild path.
        ("claude-sdk", False),
        ("claude_sdk", False),
        ("pi", False),
        # The "claude" shorthand canonicalizes to claude-sdk (not native).
        ("claude", False),
        ("some-unknown-harness", False),
        (None, False),
    ],
)
def test_is_native_harness(harness: str | None, expected: bool) -> None:
    """``is_native_harness`` flags only the native CLI harnesses.

    The runner gates terminal-owned turn sequencing and history replay on
    this. Misclassifying either way makes native TUI sessions behave like
    in-process SDK turns, or vice versa.
    """
    assert is_native_harness(harness) is expected


@pytest.mark.parametrize(
    ("harness", "expected"),
    [
        ("claude-native", "claude"),
        ("native-claude", "claude"),  # reversed alias
        # Non-native harnesses (and the SDK shorthands) have no native pane.
        ("claude-sdk", None),
        ("claude", None),
        ("pi", None),
        ("some-unknown-harness", None),
        (None, None),
    ],
)
def test_native_terminal_name(harness: str | None, expected: str | None) -> None:
    """``native_terminal_name`` maps native harness ids to their tmux pane name.

    The native-pane idle reaper (#1349) and its turn-path self-heal key panes on
    ``(conv, <short-name>, "main")``; a wrong mapping would reap/relaunch the
    wrong pane or silently skip a harness.
    """
    assert native_terminal_name(harness) == expected
