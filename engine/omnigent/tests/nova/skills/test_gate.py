"""Tests for ``omnigent.nova.skills.gate``: the server-enforced offer rules.

Each rule is a cheap, pure heuristic (no LLM call) that
:class:`~omnigent.nova.skills.service.SkillService.offer` applies before
writing anything — these tests exercise the heuristics directly, in
isolation from the store/service plumbing (covered in ``test_service.py``).
"""

from __future__ import annotations

import json

import pytest

from omnigent.entities.conversation import ConversationItem, FunctionCallOutputData, MessageData
from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.store import EpisodeStore
from omnigent.nova.skills import gate
from omnigent.nova.skills.entities import Skill

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)


def _output_item(output: str, *, item_id: str = "out_1") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="function_call_output",
        status="completed",
        response_id="resp_1",
        created_at=1_700_000_000,
        data=FunctionCallOutputData(call_id=item_id, output=output),
    )


def _user_message(text: str, *, item_id: str = "msg_user") -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="message",
        status="completed",
        response_id="resp_0",
        created_at=1_700_000_000,
        data=MessageData(role="user", content=[{"type": "input_text", "text": text}]),
    )


# ── rule 1: never after a failed turn ───────────────────────────────────────


def test_turn_is_failing_empty_results_is_fine() -> None:
    assert gate.turn_is_failing(()) is False


def test_turn_is_failing_more_failures_than_successes() -> None:
    assert gate.turn_is_failing((False, True, True)) is True


def test_turn_is_failing_minority_of_failures_is_fine() -> None:
    assert gate.turn_is_failing((False, False, True)) is False


def test_turn_is_failing_last_n_all_failed_trips_even_without_a_majority() -> None:
    # 2 successes then 3 failures: failures aren't a majority, but the most
    # recent FAILURE_STREAK_LAST_N all errored.
    assert gate.turn_is_failing((False, False, True, True, True)) is True


def test_turn_is_failing_short_failure_run_is_fine() -> None:
    # 2 failures out of 5 (not a majority), and the last 3 aren't all failed.
    assert gate.turn_is_failing((True, False, True, False, False)) is False


def test_read_turn_signals_detects_builtin_tool_error_convention() -> None:
    items_newest_first = [
        _output_item('{"error": "boom"}', item_id="most_recent"),
        _output_item('{"ok": true}', item_id="older"),
        _user_message("research canadian credit cards"),
    ]
    signals = gate.read_turn_signals(items_newest_first)
    assert signals.tool_results == (False, True)  # oldest first: ok, then error
    assert signals.latest_user_message == "research canadian credit cards"


def test_read_turn_signals_detects_mcp_plain_text_error_convention() -> None:
    # omnigent.tools.mcp._format_call_tool_result's non-image error shape.
    items_newest_first = [_output_item("Error: chart rendering failed"), _user_message("plot it")]
    signals = gate.read_turn_signals(items_newest_first)
    assert signals.tool_results == (True,)


def test_read_turn_signals_detects_mcp_is_error_envelope_convention() -> None:
    # omnigent.runtime.mcp_tool_result.encode_mcp_image_result's shape.
    envelope = json.dumps({"__omnigent_mcp_image_result__": 1, "isError": True, "content": []})
    items_newest_first = [_output_item(envelope), _user_message("chart it")]
    signals = gate.read_turn_signals(items_newest_first)
    assert signals.tool_results == (True,)


def test_read_turn_signals_stops_at_the_boundary_user_message() -> None:
    items_newest_first = [
        _output_item('{"ok": true}', item_id="this_turn"),
        _user_message("second ask"),
        _output_item('{"error": "boom"}', item_id="prior_turn"),
        _user_message("first ask"),
    ]
    signals = gate.read_turn_signals(items_newest_first)
    assert signals.tool_results == (False,)
    assert signals.latest_user_message == "second ask"


def test_read_turn_signals_no_user_message_in_lookback() -> None:
    signals = gate.read_turn_signals([_output_item('{"ok": true}')])
    assert signals.latest_user_message == ""


def test_chart_tool_failing_eight_times_is_a_failing_turn() -> None:
    """The motivating bug: a chart (MCP) tool erroring repeatedly for a
    one-off question must be read as a failing turn."""
    items_newest_first = [
        _output_item("Error: could not render chart", item_id=f"call_{i}") for i in range(8)
    ]
    items_newest_first.append(_user_message("compare canadian credit card rewards"))
    signals = gate.read_turn_signals(items_newest_first)
    assert gate.turn_is_failing(signals.tool_results) is True


# ── rule 2: a procedure, not a topic ────────────────────────────────────────

_GOOD_BODY = (
    "When to use: after finishing a repeatable multi-step research or drafting task.\n\n"
    "## Steps\n"
    "1. Gather the inputs.\n"
    "2. Do the work.\n"
    "3. Write up the result.\n"
)


def test_procedure_shape_accepts_steps_heading_and_when_to_use_line() -> None:
    assert gate.has_procedure_shape(_GOOD_BODY) is True


def test_procedure_shape_accepts_procedure_heading_with_bullets() -> None:
    body = "When to use: x.\n\n## Procedure\n- One.\n- Two.\n- Three.\n"
    assert gate.has_procedure_shape(body) is True


def test_procedure_shape_rejects_a_topic_summary_with_no_steps() -> None:
    topic = (
        "When to use: comparing Canadian credit cards.\n\n"
        "Card A has better travel rewards than Card B, and Card C has no annual fee."
    )
    assert gate.has_procedure_shape(topic) is False


def test_procedure_shape_rejects_missing_when_to_use_line() -> None:
    body = "## Steps\n1. One.\n2. Two.\n3. Three.\n"
    assert gate.has_procedure_shape(body) is False


def test_procedure_shape_rejects_too_few_steps() -> None:
    body = "When to use: x.\n\n## Steps\n1. One.\n2. Two.\n"
    assert gate.has_procedure_shape(body) is False


def test_procedure_shape_rejects_empty_body() -> None:
    assert gate.has_procedure_shape("") is False


# ── rule 3: evidence of reuse ────────────────────────────────────────────────


class _FakeEpisodeStore(EpisodeStore):
    """In-memory ``EpisodeStore`` returning a fixed list, newest-first."""

    def __init__(self, episodes: list[Episode]) -> None:
        super().__init__("memory://")
        self._episodes = episodes

    def upsert(self, **kwargs: object) -> Episode:  # pragma: no cover - unused here
        raise NotImplementedError

    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        del actor
        return self._episodes[:limit]

    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:  # pragma: no cover
        raise NotImplementedError


def _episode(title: str, summary: str, *, created_at: int = 1_700_000_000) -> Episode:
    return Episode(
        id="e" * 32,
        workspace_id=0,
        user_id=ACTOR.user_id,
        session_id="s",
        turn_id="t",
        title=title,
        summary=summary,
        tools=(),
        links=(),
        created_at=created_at,
    )


_NAME = "Weekly investor update"
_DESCRIPTION = "Summarize the week's metrics for investors."


def test_reuse_evidence_true_with_two_matching_episodes() -> None:
    store = _FakeEpisodeStore(
        [
            _episode(_NAME, _DESCRIPTION, created_at=1_700_000_000),
            _episode(_NAME, _DESCRIPTION, created_at=1_700_100_000),
            _episode("Fixed the printer jam", "Printer jam resolved.", created_at=1_700_200_000),
        ]
    )
    assert gate.has_reuse_evidence(ACTOR, _NAME, _DESCRIPTION, episode_store=store) is True


def test_reuse_evidence_false_with_only_one_matching_episode() -> None:
    store = _FakeEpisodeStore(
        [_episode(_NAME, _DESCRIPTION), _episode("Fixed the printer jam", "Printer jam resolved.")]
    )
    assert gate.has_reuse_evidence(ACTOR, _NAME, _DESCRIPTION, episode_store=store) is False


def test_reuse_evidence_false_with_no_episodes() -> None:
    store = _FakeEpisodeStore([])
    assert gate.has_reuse_evidence(ACTOR, _NAME, _DESCRIPTION, episode_store=store) is False


@pytest.mark.parametrize(
    "message",
    [
        "remember how you did that",
        "save this as a skill for later",
        "next time just do it this way",
        "always start with the summary first",
        "no, do it the other way",
        "don't email them directly, instead draft it for review",
        "can you teach you how I like these done",
    ],
)
def test_instruction_or_correction_cue_detected(message: str) -> None:
    assert gate.has_instruction_or_correction_cue(message) is True


@pytest.mark.parametrize(
    "message",
    [
        "what's the weather like",
        "find me a flight to Toronto",
        "thanks, that's exactly right",
        "",
    ],
)
def test_instruction_or_correction_cue_not_detected(message: str) -> None:
    assert gate.has_instruction_or_correction_cue(message) is False


# ── rule 4: improve before creating ──────────────────────────────────────────


def _skill(name: str, description: str) -> Skill:
    return Skill(
        id="s" * 32,
        user_id=ACTOR.user_id,
        workspace_id=0,
        name=name,
        description=description,
        content="content",
        created_at=0,
        updated_at=0,
    )


def test_find_similar_skill_matches_above_threshold() -> None:
    existing = [_skill(_NAME, _DESCRIPTION)]
    match = gate.find_similar_skill("Weekly investor summary", _DESCRIPTION, existing)
    assert match is not None
    assert match.name == _NAME


def test_find_similar_skill_returns_none_below_threshold() -> None:
    existing = [_skill("Fix the printer", "Clear a paper jam.")]
    assert gate.find_similar_skill(_NAME, "Summarize metrics.", existing) is None


def test_find_similar_skill_returns_none_when_nothing_saved() -> None:
    assert gate.find_similar_skill(_NAME, _DESCRIPTION, []) is None
