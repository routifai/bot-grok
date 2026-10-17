from __future__ import annotations

from typing import Any

import pytest

from omnigent.gateway_inference import (
    CLAUDE_GATEWAY_HARNESSES,
    CODEX_GATEWAY_HARNESSES,
    gateway_inference_map,
    gateway_inference_state,
    not_gateway_backed,
)


def test_gateway_inference_map_reports_every_spelling_not_backed() -> None:
    result = gateway_inference_map()

    assert result == dict.fromkeys((*CLAUDE_GATEWAY_HARNESSES, *CODEX_GATEWAY_HARNESSES), False)
    assert set(result) == {
        "claude-native",
        "native-claude",
        "codex",
        "codex-native",
        "native-codex",
    }


# ── Reading a reported map back ─────────────────────────────────────────────
#
# The server and the CLI both hold a harness id and a host's reported map, and
# both must tell "not gateway-backed" apart from "the host said nothing".


@pytest.mark.parametrize(
    ("gateway", "harness", "expected"),
    [
        ({"codex-native": False}, "codex-native", False),
        ({"codex-native": True}, "codex-native", True),
        # Any spelling of the family finds the family's entry, including the
        # reversed aliases that never canonicalize back.
        ({"codex": False}, "native-codex", False),
        ({"native-claude": True}, "claude-native", True),
        # Unknown: an absent entry, an absent map, and a bare family name (never
        # a key the host emits) all read as "could not tell".
        ({"claude-native": True}, "codex-native", None),
        (None, "codex-native", None),
        ({}, "codex-native", None),
        ({"claude": False}, "claude-native", None),
        # A harness in neither family has no fan-out to fall back on.
        ({"pi-native": False}, "pi-native", False),
        ({"pi-native": False}, "some-unknown-harness", None),
    ],
)
def test_gateway_inference_state_reads_any_spelling_of_the_family(
    gateway: dict[str, Any] | None,
    harness: str,
    expected: bool | None,
) -> None:
    assert gateway_inference_state(gateway, harness) is expected


def test_not_gateway_backed_names_only_the_explicit_false_arms() -> None:
    arms = ("claude-native", "codex-native")
    # Claude Code on the AI Gateway, Codex on a personal ChatGPT subscription.
    assert not_gateway_backed({"claude-native": True, "codex-native": False}, arms) == [
        "codex-native"
    ]
    assert not_gateway_backed({"claude-native": False, "codex-native": False}, arms) == list(arms)
    assert not_gateway_backed({"claude-native": True, "codex-native": True}, arms) == []
    # Unknown keeps every option: an older host must not silently lose routing.
    assert not_gateway_backed(None, arms) == []
    assert not_gateway_backed({"claude-native": True}, arms) == []
