"""The Conversation may update only the topic the person picked up, for 3 hours (ADR 0035)."""

from __future__ import annotations

from omnigent.superchat.topics.note import (
    ACTIVE_SECONDS,
    active_key,
    active_value,
    conversation_refusal,
)

PICKED = 1_800_000_000


def test_the_picked_topic_stays_active_for_three_hours_only() -> None:
    value = active_value("rbc-deck", PICKED)
    assert active_key(value, PICKED + 60) == "rbc-deck"
    assert active_key(value, PICKED + ACTIVE_SECONDS) == "rbc-deck"
    assert active_key(value, PICKED + ACTIVE_SECONDS + 1) == ""
    for unset in ("", None, "rbc-deck", "rbc-deck\tsoon", "\t1800000000"):
        assert active_key(unset, PICKED) == ""


def test_the_conversation_writes_only_its_active_topic() -> None:
    assert conversation_refusal(["rbc-deck"], "rbc-deck") == ""
    assert "rbc-deck" in conversation_refusal(["rbc-deck", "polaris"], "rbc-deck")
    assert conversation_refusal([""], "rbc-deck")
    assert conversation_refusal(["rbc-deck"], "")
