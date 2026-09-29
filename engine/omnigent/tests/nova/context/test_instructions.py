"""Tests for :data:`omnigent.nova.context.instructions.LEARNING_INSTRUCTION`.

The prose itself is what the model reads; these are light substring checks
that it still says the things the server-side gate in
``omnigent.nova.skills.gate`` actually enforces, so the two can't drift apart
silently. Behavior is tested in ``tests/nova/skills/``.
"""

from __future__ import annotations

from omnigent.nova.context.instructions import LEARNING_INSTRUCTION


def test_mentions_nova_offer_skill_as_the_only_way_to_offer() -> None:
    assert "nova_offer_skill" in LEARNING_INSTRUCTION


def test_requires_the_task_to_have_succeeded() -> None:
    assert "successfully" in LEARNING_INSTRUCTION


def test_requires_a_repeatable_procedure() -> None:
    assert "repeatable" in LEARNING_INSTRUCTION


def test_never_for_a_one_off_question() -> None:
    assert "one-off question" in LEARNING_INSTRUCTION


def test_prefers_updating_an_existing_skill() -> None:
    assert "update" in LEARNING_INSTRUCTION.lower()


def test_stays_short() -> None:
    # A short, per-turn instruction, not a restatement of gate.py's rules —
    # comparable in length to the other STATIC_INSTRUCTIONS entries.
    assert len(LEARNING_INSTRUCTION) < 1100
