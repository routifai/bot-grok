"""Unit tests for omnigent.context.rollover."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from omnigent.context.rollover import (
    CHECKPOINT_HEADER,
    DEFAULT_ROLLOVER_THRESHOLD_TOKENS,
    MAX_DEFAULT_ROLLOVER_THRESHOLD_TOKENS,
    MIN_ROLLOVER_THRESHOLD_TOKENS,
    SUMMARIZER_DATE_PLACEHOLDER,
    build_rollover_item,
    build_side_chat_seed,
    is_checkpoint_text,
    person_facing_summary,
    resolve_keep_tokens,
    resolve_rollover_threshold,
    select_recent,
    state_file_summarizer_instruction,
)
from omnigent.harnesses.claude_native import main as claude_native
from omnigent.harnesses.codex_native import main as codex_native
from omnigent.llms.types import MessageOutput, OutputText, Response
from omnigent.runtime.compaction import count_tokens
from omnigent.server.routes._sessions.common import (
    _LAST_CONTEXT_WINDOW_LABEL_KEY,
)

# Generous enough that no test below hits it unless it's specifically
# exercising the token budget.
_HUGE_TOKENS = 1_000_000


def _msg(item_id: str, role: str, text: str, response_id: str | None = None) -> dict[str, Any]:
    return {
        "id": item_id,
        "type": "message",
        "status": "completed",
        "response_id": response_id or f"resp_{item_id}",
        "created_at": 1,
        "role": role,
        "content": [
            {"type": "input_text" if role == "user" else "output_text", "text": text},
        ],
    }


def _tool_pair(call_id: str, response_id: str) -> list[dict[str, Any]]:
    return [
        {
            "id": f"fc_{call_id}",
            "type": "function_call",
            "status": "completed",
            "response_id": response_id,
            "created_at": 1,
            "call_id": call_id,
            "name": "some_tool",
            "arguments": "{}",
        },
        {
            "id": f"fo_{call_id}",
            "type": "function_call_output",
            "status": "completed",
            "response_id": response_id,
            "created_at": 1,
            "call_id": call_id,
            "output": "ok",
        },
    ]


def _turn(n: int, *, with_tool: bool = False) -> list[dict[str, Any]]:
    """One whole turn: a user message, optionally a tool round-trip, then
    an assistant reply — the unit select_recent now walks in whole."""
    items = [_msg(f"u{n}", "user", f"question {n}", response_id=f"r{n}")]
    if with_tool:
        items += _tool_pair(f"c{n}", f"r{n}")
    items.append(_msg(f"a{n}", "assistant", f"answer {n}", response_id=f"r{n}"))
    return items


class _ReturnsTextClient:
    """LLM client stub returning a fixed summary, matching the real Response shape."""

    def __init__(self, text: str) -> None:
        self._text = text
        self.call_count = 0
        self.seen_messages: list[dict[str, Any]] | None = None
        self.seen_instructions: str | None = None

    class _Responses:
        def __init__(self, outer: _ReturnsTextClient) -> None:
            self._outer = outer

        async def create(self, **kwargs: Any) -> Response:
            self._outer.call_count += 1
            self._outer.seen_messages = kwargs.get("input")
            self._outer.seen_instructions = kwargs.get("instructions")
            return Response(
                output=[MessageOutput(content=[OutputText(text=self._outer._text)])],
                model="test-model",
            )

    @property
    def responses(self) -> _ReturnsTextClient._Responses:
        return self._Responses(self)


# ── select_recent: whole-turn selection ─────────────────────────────────


def test_select_recent_always_keeps_the_last_turn() -> None:
    """Rollover runs right after a turn finishes; that turn stays verbatim
    even when it alone is over budget."""
    items = _turn(1) + _turn(2)
    result = select_recent(items, keep_tokens=1, model="gpt-4o")
    assert [i["id"] for i in result] == ["u2", "a2"]


def test_select_recent_keeps_tool_items_riding_within_their_turn() -> None:
    items = _turn(1) + _turn(2, with_tool=True)
    result = select_recent(items, keep_tokens=1, model="gpt-4o")
    assert [i["id"] for i in result] == ["u2", "fc_c2", "fo_c2", "a2"]


def test_select_recent_adds_earlier_whole_turns_within_budget() -> None:
    items = _turn(1) + _turn(2) + _turn(3)
    two_turns = count_tokens(items[2:], "gpt-4o")
    result = select_recent(items, keep_tokens=two_turns, model="gpt-4o")
    assert [i["id"] for i in result] == ["u2", "a2", "u3", "a3"]


def test_select_recent_tail_always_starts_at_a_user_message() -> None:
    items = _turn(1) + _turn(2, with_tool=True) + _turn(3)
    for budget in (1, 50, 200, _HUGE_TOKENS):
        result = select_recent(items, keep_tokens=budget, model="gpt-4o")
        assert result[0]["role"] == "user", f"budget={budget} started on {result[0]!r}"


def test_select_recent_empty_items() -> None:
    assert select_recent([], keep_tokens=_HUGE_TOKENS, model="gpt-4o") == []


def test_select_recent_no_user_message_is_empty_tail() -> None:
    # Malformed/partial record with no turn to anchor a tail on.
    items = [_msg("a1", "assistant", "orphan reply")]
    assert select_recent(items, keep_tokens=_HUGE_TOKENS, model="gpt-4o") == []


# ── threshold / keep-budget resolution ──────────────────────────────────


def test_threshold_default_when_no_label_or_window() -> None:
    assert resolve_rollover_threshold(None) == DEFAULT_ROLLOVER_THRESHOLD_TOKENS
    assert resolve_rollover_threshold({}) == DEFAULT_ROLLOVER_THRESHOLD_TOKENS


def test_threshold_falls_back_to_60pct_of_context_window() -> None:
    labels = {_LAST_CONTEXT_WINDOW_LABEL_KEY: "300000"}
    assert resolve_rollover_threshold(labels) == 180_000


def test_threshold_default_caps_at_max_for_a_huge_window() -> None:
    # 60% of 1M would be 600,000; the default is capped at 200,000.
    labels = {_LAST_CONTEXT_WINDOW_LABEL_KEY: "1000000"}
    assert resolve_rollover_threshold(labels) == MAX_DEFAULT_ROLLOVER_THRESHOLD_TOKENS


def test_threshold_explicit_label_is_not_capped() -> None:
    # The cap applies only to the derived default, never to an explicit label.
    labels = {
        "omnigent.context.rollover_at_tokens": "250000",
        _LAST_CONTEXT_WINDOW_LABEL_KEY: "1000000",
    }
    assert resolve_rollover_threshold(labels) == 250_000


def test_threshold_uses_model_window_when_no_window_label() -> None:
    assert resolve_rollover_threshold(None, model_window=300_000) == 180_000


def test_threshold_window_label_wins_over_model_window() -> None:
    # 60% of the labeled 100,000 window is below the floor, so the 80%-of-window
    # floor applies (80,000) — proof the much larger model_window is ignored.
    labels = {_LAST_CONTEXT_WINDOW_LABEL_KEY: "100000"}
    assert resolve_rollover_threshold(labels, model_window=1_000_000) == 80_000


def test_threshold_ignores_non_positive_model_window() -> None:
    assert resolve_rollover_threshold(None, model_window=0) == DEFAULT_ROLLOVER_THRESHOLD_TOKENS


def test_threshold_explicit_label_wins_over_window() -> None:
    labels = {
        "omnigent.context.rollover_at_tokens": "150000",
        _LAST_CONTEXT_WINDOW_LABEL_KEY: "400000",
    }
    assert resolve_rollover_threshold(labels) == 150_000


def test_threshold_never_drops_below_the_floor() -> None:
    assert (
        resolve_rollover_threshold({"omnigent.context.rollover_at_tokens": "12345"})
        == MIN_ROLLOVER_THRESHOLD_TOKENS
    )
    # A small window caps the floor so the CLI still compacts before its limit.
    labels = {
        "omnigent.context.rollover_at_tokens": "5000",
        _LAST_CONTEXT_WINDOW_LABEL_KEY: "100000",
    }
    assert resolve_rollover_threshold(labels) == 80_000


def test_threshold_ignores_invalid_label() -> None:
    labels = {"omnigent.context.rollover_at_tokens": "not-a-number"}
    assert resolve_rollover_threshold(labels) == DEFAULT_ROLLOVER_THRESHOLD_TOKENS


def test_resolve_keep_tokens_default_and_override() -> None:
    assert resolve_keep_tokens(None) == 16_000
    assert resolve_keep_tokens({"omnigent.context.rollover_keep_tokens": "5000"}) == 5000
    assert resolve_keep_tokens({"omnigent.context.rollover_keep_tokens": "-1"}) == 16_000


# ── build_rollover_item + resume-rebuilder acceptance ────────────────────


@pytest.mark.asyncio
async def test_build_rollover_item_shape() -> None:
    items = _turn(1) + _turn(2) + _turn(3)
    client = _ReturnsTextClient("ROLLING SUMMARY")

    data = await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=1,
        model="gpt-4o",
        llm_client=client,
    )

    assert data.summary == f"{CHECKPOINT_HEADER}\n\nROLLING SUMMARY"
    assert data.last_item_id == "a3"
    # token_count is the summary + kept tail estimate, not just the summary.
    assert data.token_count == count_tokens(data.compacted_messages, "gpt-4o")
    assert data.compacted_messages is not None
    assert [m.get("type") for m in data.compacted_messages] == [
        "message",
        "message",
        "message",
        "message",
    ]
    assert data.compacted_messages[-2]["id"] == "u3"
    assert data.compacted_messages[-1]["id"] == "a3"


@pytest.mark.asyncio
async def test_build_rollover_item_keeps_the_last_turn_even_over_budget() -> None:
    items = _turn(1) + _turn(2)
    client = _ReturnsTextClient("ROLLING SUMMARY")

    data = await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=1,
        model="gpt-4o",
        llm_client=client,
    )

    # Only the summary pair — no room for even the latest turn.
    assert len(data.compacted_messages) == 4
    assert [m.get("id") for m in data.compacted_messages[2:]] == ["u2", "a2"]
    assert data.compacted_messages[0]["role"] == "user"
    assert data.compacted_messages[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_build_rollover_item_passes_state_file_instruction() -> None:
    items = _turn(1)
    client = _ReturnsTextClient("SUMMARY")

    await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=_HUGE_TOKENS,
        model="gpt-4o",
        llm_client=client,
    )

    assert client.seen_instructions is not None
    assert "state file" in client.seen_instructions
    assert "Context checkpoint" in client.seen_instructions


@pytest.mark.asyncio
async def test_build_rollover_item_feeds_previous_summary_for_progressive_summarization() -> None:
    items = _turn(1)
    client = _ReturnsTextClient("NEW SUMMARY")

    await build_rollover_item(
        items,
        previous_summary=f"{CHECKPOINT_HEADER}\n\nOLD SUMMARY of earlier turns",
        keep_tokens=_HUGE_TOKENS,
        model="gpt-4o",
        llm_client=client,
    )

    assert client.seen_messages is not None
    first_text = client.seen_messages[0]["content"][0]["text"]
    assert "automatically generated summary" in first_text


@pytest.mark.asyncio
async def test_build_rollover_item_requires_nonempty_items() -> None:
    with pytest.raises(ValueError):
        await build_rollover_item(
            [],
            previous_summary=None,
            keep_tokens=_HUGE_TOKENS,
            model="gpt-4o",
            llm_client=_ReturnsTextClient("x"),
        )


@pytest.mark.asyncio
async def test_rollover_item_accepted_by_claude_native_resume_rebuild(tmp_path: Path) -> None:
    items = _turn(1) + _turn(2) + _turn(3) + _turn(4)
    client = _ReturnsTextClient("ROLLING SUMMARY")
    data = await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=1,
        model="gpt-4o",
        llm_client=client,
    )
    compaction_item = {
        "id": "comp_1",
        "type": "compaction",
        "status": "completed",
        "response_id": "resp_comp_1",
        "created_at": 2,
        "summary": data.summary,
        "last_item_id": data.last_item_id,
        "token_count": data.token_count,
        "compacted_messages": data.compacted_messages,
    }
    records = claude_native._claude_transcript_records_from_session_items(
        [*items, compaction_item],
        session_id="conv_test",
        external_session_id="02857840-6362-408f-b41f-309e396ed7c6",
        cwd=tmp_path,
        bridge_dir=tmp_path / "bridge",
    )
    # Only the compact boundary + summary exchange + the last whole turn.
    assert [r.get("type") for r in records] == ["system", "user", "assistant", "user", "assistant"]
    assert records[0].get("subtype") == "compact_boundary"
    last_texts = [b.get("text") for b in records[-1]["message"]["content"] if isinstance(b, dict)]
    assert last_texts == ["answer 4"]


@pytest.mark.asyncio
async def test_rollover_item_accepted_by_codex_native_resume_rebuild(tmp_path: Path) -> None:
    items = _turn(1) + _turn(2) + _turn(3) + _turn(4)
    client = _ReturnsTextClient("ROLLING SUMMARY")
    data = await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=1,
        model="gpt-4o",
        llm_client=client,
    )
    compaction_item = {
        "id": "comp_1",
        "type": "compaction",
        "status": "completed",
        "response_id": "resp_comp_1",
        "created_at": 2,
        "summary": data.summary,
        "last_item_id": data.last_item_id,
        "token_count": data.token_count,
        "compacted_messages": data.compacted_messages,
    }
    records = codex_native._codex_rollout_records_from_session_items(
        [*items, compaction_item],
        session_id="conv_test",
        external_session_id="019e96aa-0be2-7343-8d3b-6f914d60936b",
        cwd=tmp_path,
        model_provider="omnigent_test",
        cli_version="0.999.0",
    )
    record_types = [r.get("type") for r in records]
    assert record_types == ["session_meta", "compacted"]
    replacement_history = records[1]["payload"]["replacement_history"]
    assert records[1]["payload"]["message"] == f"{CHECKPOINT_HEADER}\n\nROLLING SUMMARY"
    kept_ids = [m.get("id") for m in replacement_history if "id" in m]
    assert kept_ids == ["u4", "a4"]
    # The system marker is re-roled to developer; real turns keep their roles.
    assert replacement_history[0]["role"] == "developer"
    assert [m["role"] for m in replacement_history if "id" in m] == ["user", "assistant"]


def test_state_file_summarizer_instruction_defaults_to_utc_today() -> None:
    instruction = state_file_summarizer_instruction()
    assert "## Context checkpoint —" in instruction
    assert SUMMARIZER_DATE_PLACEHOLDER not in instruction


def test_state_file_summarizer_instruction_accepts_a_caller_supplied_date() -> None:
    """The pi-native bridge passes SUMMARIZER_DATE_PLACEHOLDER at launch time
    and substitutes the real date itself, later, at actual compaction time."""
    instruction = state_file_summarizer_instruction(today=SUMMARIZER_DATE_PLACEHOLDER)
    assert f"## Context checkpoint — {SUMMARIZER_DATE_PLACEHOLDER}" in instruction


def test_items_for_summarizer_keeps_only_provider_schema_fields() -> None:
    from omnigent.context.rollover import _items_for_summarizer

    items = [
        {
            "id": "m1",
            "type": "message",
            "role": "user",
            "status": "completed",
            "stream_message_id": "s1",
            "content": [{"type": "input_text", "text": "hi", "extra": 1}],
        },
        {"id": "r1", "type": "reasoning", "summary": []},
        {"id": "e1", "type": "native_tool", "name": "shell"},
        {"id": "f1", "type": "function_call", "call_id": "c1", "name": "t", "arguments": "{}"},
        {"id": "o1", "type": "function_call_output", "call_id": "c1", "output": "ok", "x": 2},
    ]
    assert _items_for_summarizer(items) == [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        {"type": "function_call", "call_id": "c1", "name": "t", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "c1", "output": "ok"},
    ]


@pytest.mark.asyncio
async def test_checkpoint_marker_differs_from_the_summarizer_request() -> None:
    """The CLI must see a marker that's plainly not from the user, while the
    summarizer keeps the request wording it expects for a previous summary."""
    from omnigent.context.rollover import _SUMMARY_REQUEST_TEXT

    client = _ReturnsTextClient("ROLLING SUMMARY")
    data = await build_rollover_item(
        _turn(1) + _turn(2),
        previous_summary="OLD SUMMARY",
        keep_tokens=_HUGE_TOKENS,
        model="gpt-4o",
        llm_client=client,
    )
    marker = data.compacted_messages[0]["content"][0]["text"]
    assert marker == CHECKPOINT_HEADER
    assert "not a message from the user" in marker
    assert _SUMMARY_REQUEST_TEXT != CHECKPOINT_HEADER


@pytest.mark.asyncio
async def test_summarizer_gets_one_transcript_message_not_live_turns() -> None:
    """Live chat turns let a weak summarizer continue the chat; a single quoted
    transcript (with the previous summary on top) can only be summarized."""
    client = _ReturnsTextClient("ROLLING SUMMARY")
    await build_rollover_item(
        _turn(1) + _turn(2),
        previous_summary="OLD SUMMARY",
        keep_tokens=_HUGE_TOKENS,
        model="gpt-4o",
        llm_client=client,
    )
    assert client.seen_messages is not None
    user_texts = [
        block["text"]
        for message in client.seen_messages
        if message.get("role") == "user"
        for block in message["content"]
        if isinstance(block, dict) and "text" in block
    ]
    transcript = user_texts[0]
    assert "OLD SUMMARY" in transcript
    assert "<conversation>" in transcript
    assert not any(m.get("role") == "assistant" for m in client.seen_messages)
    assert "automatically generated summary" in client.seen_instructions + transcript


@pytest.mark.asyncio
async def test_kept_tool_output_is_capped_so_one_turn_cannot_loop_rollovers() -> None:
    """A huge tool result in the always-kept last turn is cut, so the relaunched
    context can drop under the threshold instead of rolling over every turn."""
    from omnigent.context.rollover import _KEPT_OUTPUT_MAX_CHARS

    items = _turn(1) + _turn(2, with_tool=True)
    output_item = next(i for i in items if i["type"] == "function_call_output")
    output_item["output"] = "x" * (_KEPT_OUTPUT_MAX_CHARS * 5)
    data = await build_rollover_item(
        items,
        previous_summary=None,
        keep_tokens=1,
        model="gpt-4o",
        llm_client=_ReturnsTextClient("S"),
    )
    kept = next(m for m in data.compacted_messages if m.get("type") == "function_call_output")
    assert len(kept["output"]) < _KEPT_OUTPUT_MAX_CHARS + 200
    assert "session_history" in kept["output"]
    assert len(output_item["output"]) == _KEPT_OUTPUT_MAX_CHARS * 5  # record untouched


@pytest.mark.asyncio
async def test_previous_header_is_not_fed_back_so_it_never_nests() -> None:
    client = _ReturnsTextClient("NEW SUMMARY")
    data = await build_rollover_item(
        _turn(1),
        previous_summary=f"{CHECKPOINT_HEADER}\n\nOLD SUMMARY",
        keep_tokens=1,
        model="gpt-4o",
        llm_client=client,
    )
    transcript = client.seen_messages[0]["content"][0]["text"]
    assert "OLD SUMMARY" in transcript
    assert CHECKPOINT_HEADER not in transcript
    assert data.summary.count(CHECKPOINT_HEADER) == 1


def test_checkpoint_marker_as_developer_only_touches_the_marker() -> None:
    """A user message that merely mentions the marker later is left alone."""
    from omnigent.context.rollover import CHECKPOINT_MARKER

    def msg(role: str, text: str) -> dict:
        return {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}

    history = [
        msg("user", f"{CHECKPOINT_MARKER} rest"),
        msg("assistant", "summary"),
        msg("user", f"please explain {CHECKPOINT_MARKER}"),
    ]
    out = codex_native._checkpoint_marker_as_developer(history)
    assert [m["role"] for m in out] == ["developer", "assistant", "user"]
    assert history[0]["role"] == "user"


# ---------------------------------------------------------------------------
# build_post_compaction_tail
# ---------------------------------------------------------------------------


def _rollover_labels(extra: dict[str, str] | None = None) -> dict[str, str]:
    from omnigent.context.labels import CONTEXT_MODE_LABEL, ROLLOVER_MODE_VALUE

    return {CONTEXT_MODE_LABEL: ROLLOVER_MODE_VALUE, **(extra or {})}


def _compaction_item(item_id: str = "comp_1") -> dict[str, Any]:
    return {"id": item_id, "type": "compaction", "summary": "…", "last_item_id": "u1"}


def test_post_compaction_tail_none_without_rollover_label() -> None:
    from omnigent.context.rollover import build_post_compaction_tail

    items = [*_turn(1), _compaction_item()]
    assert build_post_compaction_tail(items, {}, model="gpt-4o") is None
    assert build_post_compaction_tail(items, None, model="gpt-4o") is None


def test_post_compaction_tail_none_without_a_compaction_item() -> None:
    from omnigent.context.rollover import build_post_compaction_tail

    assert build_post_compaction_tail(_turn(1), _rollover_labels(), model="gpt-4o") is None


def test_post_compaction_tail_none_when_compaction_is_the_first_item() -> None:
    from omnigent.context.rollover import build_post_compaction_tail

    items = [_compaction_item(), *_turn(1)]
    assert build_post_compaction_tail(items, _rollover_labels(), model="gpt-4o") is None


def test_post_compaction_tail_renders_markers_and_whole_turns() -> None:
    from omnigent.context.rollover import build_post_compaction_tail

    items = [*_turn(1, with_tool=True), _compaction_item()]
    tail = build_post_compaction_tail(items, _rollover_labels(), model="gpt-4o")
    assert tail is not None
    lines = tail.splitlines()
    assert lines[0] == (
        "[Recent conversation before the context was compacted — verbatim, "
        "provided by the system, not a new message from the user]"
    )
    assert lines[-1] == "[End of recent conversation]"
    assert "User: question 1" in tail
    assert "Assistant: answer 1" in tail
    assert "Tool call some_tool: {}" in tail
    assert "Tool result: ok" in tail


def test_post_compaction_tail_selection_stays_within_keep_tokens_budget() -> None:
    """Only the trailing whole turn survives a tight budget."""
    from omnigent.context.labels import ROLLOVER_KEEP_TOKENS_LABEL
    from omnigent.context.rollover import build_post_compaction_tail

    items = [*_turn(1), *_turn(2), _compaction_item()]
    tail = build_post_compaction_tail(
        items, _rollover_labels({ROLLOVER_KEEP_TOKENS_LABEL: "1"}), model="gpt-4o"
    )
    assert tail is not None
    assert "question 1" not in tail
    assert "question 2" in tail
    assert "answer 2" in tail


def test_post_compaction_tail_caps_oversized_tool_output() -> None:
    from omnigent.context.rollover import _KEPT_OUTPUT_MAX_CHARS, build_post_compaction_tail

    items = _turn(1, with_tool=True)
    for item in items:
        if item.get("type") == "function_call_output":
            item["output"] = "x" * (_KEPT_OUTPUT_MAX_CHARS * 5)
    items.append(_compaction_item())
    tail = build_post_compaction_tail(items, _rollover_labels(), model="gpt-4o")
    assert tail is not None
    assert "x" * (_KEPT_OUTPUT_MAX_CHARS * 5) not in tail
    assert "output truncated at rollover" in tail


def test_post_compaction_tail_excludes_reasoning_and_lifecycle_items() -> None:
    from omnigent.context.rollover import build_post_compaction_tail

    items = [
        {"id": "r1", "type": "reasoning", "summary": []},
        *_turn(1),
        {"id": "err1", "type": "error", "message": "boom"},
        _compaction_item(),
    ]
    tail = build_post_compaction_tail(items, _rollover_labels(), model="gpt-4o")
    assert tail is not None
    assert "boom" not in tail
    assert "question 1" in tail


def test_post_compaction_tail_ignores_items_after_the_latest_compaction() -> None:
    """Only the LATEST compaction's boundary matters; a turn that happened
    AFTER it (not yet compacted) is never part of the tail."""
    from omnigent.context.rollover import build_post_compaction_tail

    items = [
        *_turn(1),
        _compaction_item("comp_1"),
        *_turn(2),
        _compaction_item("comp_2"),
        *_turn(3),
    ]
    tail = build_post_compaction_tail(items, _rollover_labels(), model="gpt-4o")
    assert tail is not None
    assert "question 2" in tail
    assert "question 3" not in tail


# ---------------------------------------------------------------------------
# consume_post_compaction_tail / prefix_latest_user_item
# ---------------------------------------------------------------------------


def test_consume_post_compaction_tail_fires_once_per_compaction() -> None:
    from omnigent.context.rollover import consume_post_compaction_tail

    items = [*_turn(1), _compaction_item()]
    first = consume_post_compaction_tail(
        items, _rollover_labels(), session_id="consume-once", model="gpt-4o"
    )
    assert first is not None
    assert "question 1" in first

    second = consume_post_compaction_tail(
        items, _rollover_labels(), session_id="consume-once", model="gpt-4o"
    )
    assert second is None


def test_consume_post_compaction_tail_re_arms_on_a_later_compaction() -> None:
    from omnigent.context.rollover import consume_post_compaction_tail

    session_id = "consume-rearm"
    first_items = [*_turn(1), _compaction_item("comp_a")]
    assert (
        consume_post_compaction_tail(
            first_items, _rollover_labels(), session_id=session_id, model="gpt-4o"
        )
        is not None
    )

    later_items = [*first_items, *_turn(2), _compaction_item("comp_b")]
    second = consume_post_compaction_tail(
        later_items, _rollover_labels(), session_id=session_id, model="gpt-4o"
    )
    assert second is not None
    assert "question 2" in second


def test_consume_post_compaction_tail_scoped_per_session() -> None:
    """Two sessions sharing the same compaction id each get the tail once."""
    from omnigent.context.rollover import consume_post_compaction_tail

    items = [*_turn(1), _compaction_item("shared_comp")]
    for session_id in ("consume-session-a", "consume-session-b"):
        tail = consume_post_compaction_tail(
            items, _rollover_labels(), session_id=session_id, model="gpt-4o"
        )
        assert tail is not None


def test_consume_post_compaction_tail_none_without_a_compaction() -> None:
    from omnigent.context.rollover import consume_post_compaction_tail

    assert (
        consume_post_compaction_tail(
            _turn(1), _rollover_labels(), session_id="consume-no-compaction", model="gpt-4o"
        )
        is None
    )


def test_prefix_latest_user_item_adds_to_existing_text_block() -> None:
    from omnigent.context.rollover import prefix_latest_user_item

    items = [*_turn(1), _msg("u2", "user", "pending question")]
    updated = prefix_latest_user_item(items, "TAIL")
    assert updated[-1]["content"][0]["text"] == "TAIL\n\npending question"
    # Earlier items and the original list are untouched.
    assert items[-1]["content"][0]["text"] == "pending question"
    assert updated[0] is items[0]


def test_prefix_latest_user_item_handles_string_content() -> None:
    from omnigent.context.rollover import prefix_latest_user_item

    items = [{"type": "message", "role": "user", "content": "pending question"}]
    updated = prefix_latest_user_item(items, "TAIL")
    assert updated[0]["content"] == "TAIL\n\npending question"


def test_prefix_latest_user_item_inserts_block_when_text_blocks_absent() -> None:
    from omnigent.context.rollover import prefix_latest_user_item

    items = [{"type": "message", "role": "user", "content": [{"type": "input_image"}]}]
    updated = prefix_latest_user_item(items, "TAIL")
    assert updated[0]["content"][0] == {"type": "input_text", "text": "TAIL"}


def test_prefix_latest_user_item_no_user_message_is_a_no_op() -> None:
    from omnigent.context.rollover import prefix_latest_user_item

    items = [_msg("a1", "assistant", "hello")]
    assert prefix_latest_user_item(items, "TAIL") == items


def test_list_related_chats_does_not_match_two_unowned_sessions(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two sessions with no owner grant on record must not read as
    related to each other — ``None == None`` is not "same owner" outside
    single-user mode, where every session's owner reads back ``None``."""
    from omnigent.context.rollover import list_related_chats
    from omnigent.stores.conversation_store import (
        FORK_SOURCE_LABEL_KEY,
        SIDE_CHAT_LABEL_KEY,
    )
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    monkeypatch.delenv("OMNIGENT_LOCAL_SINGLE_USER", raising=False)
    conv_store = SqlAlchemyConversationStore(db_uri)

    unowned_parent = conv_store.create_conversation()
    unowned_child = conv_store.create_conversation(
        labels={FORK_SOURCE_LABEL_KEY: unowned_parent.id, SIDE_CHAT_LABEL_KEY: "1"}
    )

    assert list_related_chats(conv_store, unowned_child.id) == []


def test_list_related_chats_single_user_mode_still_matches_unowned_sessions(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On a single-user server (no permission store ever writes grants),
    every session's owner reads back ``None`` — the one case two ``None``s
    are the same (one) user, so related chats keep working."""
    from omnigent.context.rollover import list_related_chats
    from omnigent.stores.conversation_store import (
        FORK_SOURCE_LABEL_KEY,
        SIDE_CHAT_LABEL_KEY,
    )
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)

    parent = conv_store.create_conversation()
    child = conv_store.create_conversation(
        labels={FORK_SOURCE_LABEL_KEY: parent.id, SIDE_CHAT_LABEL_KEY: "1"}
    )

    related_ids = [chat["id"] for chat in list_related_chats(conv_store, child.id)]
    assert related_ids == [parent.id]


def test_list_related_chats_finds_side_chats_by_parent_label_and_old_fork_label(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A Side Chat opened now links by its parent label; an older one only by the fork label."""
    from omnigent.context.rollover import list_related_chats
    from omnigent.stores.conversation_store import (
        FORK_SOURCE_LABEL_KEY,
        SIDE_CHAT_LABEL_KEY,
        SIDE_CHAT_PARENT_LABEL_KEY,
    )
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    parent = conv_store.create_conversation()
    new = conv_store.create_conversation(
        labels={SIDE_CHAT_PARENT_LABEL_KEY: parent.id, SIDE_CHAT_LABEL_KEY: "1"}
    )
    old = conv_store.create_conversation(
        labels={FORK_SOURCE_LABEL_KEY: parent.id, SIDE_CHAT_LABEL_KEY: "1"}
    )

    assert {c["id"] for c in list_related_chats(conv_store, parent.id)} == {new.id, old.id}
    assert [c["id"] for c in list_related_chats(conv_store, new.id)] == [parent.id]


def test_list_related_chats_returns_every_side_chat_past_twenty_and_the_page_size(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A family of >20 (and >one store page of) Side Chats is returned whole, never cut at 20,
    and non-Side-Chat forks do not hide any; ``limit`` caps the children but keeps the parent."""
    from omnigent.context.rollover import RELATED_CHATS_MAX, list_related_chats
    from omnigent.stores.conversation_store import (
        FORK_SOURCE_LABEL_KEY,
        SIDE_CHAT_LABEL_KEY,
        SIDE_CHAT_PARENT_LABEL_KEY,
    )
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    parent = conv_store.create_conversation()
    side_ids = {
        conv_store.create_conversation(
            labels={SIDE_CHAT_PARENT_LABEL_KEY: parent.id, SIDE_CHAT_LABEL_KEY: "1"}
        ).id
        for _ in range(120)
    }
    for _ in range(3):  # a plain fork that is not a Side Chat
        conv_store.create_conversation(labels={FORK_SOURCE_LABEL_KEY: parent.id})

    assert RELATED_CHATS_MAX > 120
    assert {c["id"] for c in list_related_chats(conv_store, parent.id)} == side_ids

    capped = [c["id"] for c in list_related_chats(conv_store, parent.id, limit=30)]
    assert len(capped) == 30 and set(capped) <= side_ids

    # From a Side Chat of a long family the parent still comes back.
    one = next(iter(side_ids))
    assert list_related_chats(conv_store, one)[-1]["id"] == parent.id
    assert [c["id"] for c in list_related_chats(conv_store, one, limit=0)] == [parent.id]


def test_list_related_chats_scheduled_helper_sees_parent_but_plain_subagent_does_not(
    db_uri: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A scheduled Helper (Study, Check-in) may read its parent chat; an ordinary
    Sub-agent stays confined to its Brief."""
    from omnigent.context.labels import ADHOC_HELPER_LABEL_KEY, SCHEDULED_HELPER_LABEL_KEY
    from omnigent.context.rollover import list_related_chats
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    monkeypatch.setenv("OMNIGENT_LOCAL_SINGLE_USER", "1")
    conv_store = SqlAlchemyConversationStore(db_uri)
    parent = conv_store.create_conversation()
    adhoc = conv_store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        title="analyst:Daily note",
        labels={ADHOC_HELPER_LABEL_KEY: "t2"},
    )
    assert [c["id"] for c in list_related_chats(conv_store, adhoc.id)] == [parent.id]
    scheduled = conv_store.create_conversation(
        kind="sub_agent",
        parent_conversation_id=parent.id,
        title="analyst:Study",
        labels={SCHEDULED_HELPER_LABEL_KEY: "t1"},
    )
    plain = conv_store.create_conversation(
        kind="sub_agent", parent_conversation_id=parent.id, title="analyst:other"
    )

    assert [c["id"] for c in list_related_chats(conv_store, scheduled.id)] == [parent.id]
    assert list_related_chats(conv_store, plain.id) == []


@pytest.mark.asyncio
async def test_side_chat_seed_stops_at_parents_last_reply() -> None:
    """A Side Chat opened mid-turn must not inherit the request opening it."""
    items = _turn(1) + _turn(2) + [_msg("u3", "user", "open a side chat")]
    client = _ReturnsTextClient("SUMMARY")

    data = await build_side_chat_seed(
        items, keep_tokens=100_000, model="gpt-4o", llm_client=client
    )

    assert data.last_item_id == "a2"
    assert data.compacted_messages is not None
    assert all(m.get("id") != "u3" for m in data.compacted_messages)


@pytest.mark.asyncio
async def test_side_chat_seed_uses_side_chat_framing_not_the_rollover_header() -> None:
    """The seed must not tell the model it IS the conversation that rolled over."""
    from omnigent.context.rollover import CHECKPOINT_HEADER, SIDE_CHAT_SEED_HEADER

    data = await build_side_chat_seed(
        _turn(1) + _turn(2),
        keep_tokens=100_000,
        model="gpt-4o",
        llm_client=_ReturnsTextClient("SUMMARY"),
    )

    assert data.summary.startswith(SIDE_CHAT_SEED_HEADER)
    assert data.summary.endswith("SUMMARY")
    assert CHECKPOINT_HEADER not in data.summary
    assert data.compacted_messages is not None
    first = data.compacted_messages[0]["content"][0]["text"]
    assert first.startswith(SIDE_CHAT_SEED_HEADER)
    assert "grew past its context limit" not in first
    # Codex re-roles any seed marker to developer; a side chat seed must still match.
    assert is_checkpoint_text(first)
    [rerolled] = codex_native._checkpoint_marker_as_developer(data.compacted_messages[:1])
    assert rerolled["role"] == "developer"


def test_summarizer_instruction_forbids_listing_tool_names() -> None:
    assert "Never list tool names" in state_file_summarizer_instruction()


@pytest.mark.asyncio
async def test_side_chat_seed_with_no_reply_yet_still_excludes_the_trailing_request() -> None:
    """Even with NO assistant reply anywhere in the record yet, the seed
    must not inherit the unanswered request opening this fork — it stops
    before the last user message too, not just the last reply."""
    items = [_msg("u1", "user", "first message"), _msg("u2", "user", "open a side chat")]
    client = _ReturnsTextClient("SUMMARY")

    data = await build_side_chat_seed(
        items, keep_tokens=100_000, model="gpt-4o", llm_client=client
    )

    assert data.last_item_id == "u1"
    assert data.compacted_messages is not None
    assert all(m.get("id") != "u2" for m in data.compacted_messages)


@pytest.mark.asyncio
async def test_fork_seed_ends_at_its_anchor_even_a_question() -> None:
    """A Fork (ADR 0010) knows the parent up to and including its anchor, nothing later."""
    items = _turn(1) + _turn(2) + _turn(3)

    data = await build_side_chat_seed(
        items,
        keep_tokens=100_000,
        model="gpt-4o",
        llm_client=_ReturnsTextClient("SUMMARY"),
        anchor_item_id="u2",
    )

    assert data.last_item_id == "u2"  # a chosen question is kept, unlike the mid-turn trim
    assert data.compacted_messages is not None
    kept = {m.get("id") for m in data.compacted_messages}
    assert "u2" in kept and not kept & {"a2", "u3", "a3"}
    with pytest.raises(ValueError, match="fork anchor"):
        await build_side_chat_seed(
            items,
            keep_tokens=100_000,
            model="gpt-4o",
            llm_client=_ReturnsTextClient("S"),
            anchor_item_id="missing",
        )


@pytest.mark.asyncio
async def test_side_chat_seed_with_only_one_unanswered_message_keeps_it() -> None:
    """Truncating before the lone trailing user message would leave nothing
    to seed from — keep it rather than seed from an empty record."""
    items = [_msg("u1", "user", "open a side chat right away")]
    client = _ReturnsTextClient("SUMMARY")

    data = await build_side_chat_seed(
        items, keep_tokens=100_000, model="gpt-4o", llm_client=client
    )

    assert data.last_item_id == "u1"


def test_state_file_instruction_stamps_time_and_zone_by_default() -> None:
    """A bare date is ambiguous across time zones; the default carries time and UTC."""
    import re

    instruction = state_file_summarizer_instruction()

    assert re.search(r"## Context checkpoint — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC", instruction)


@pytest.mark.asyncio
async def test_build_rollover_item_rejects_an_empty_summary() -> None:
    """An empty/blank summarizer reply must raise so the caller keeps the previous checkpoint."""
    with pytest.raises(ValueError, match="no summary text"):
        await build_rollover_item(
            _turn(1) + _turn(2),
            previous_summary=None,
            keep_tokens=1,
            model="gpt-4o",
            llm_client=_ReturnsTextClient("   "),
        )


def test_summarizer_instruction_forbids_recording_tool_errors_as_facts() -> None:
    text = state_file_summarizer_instruction(today="2026-01-01")
    assert "Tool errors" in text
    assert "never claim earlier messages are inaccessible" in text


def test_side_chat_seed_is_this_chats_checkpoint_not_the_copied_parents() -> None:
    """The fork's deep copy carries the parent's own compactions before the seed."""
    from types import SimpleNamespace

    from omnigent.context.rollover import side_chat_seed_checkpoint
    from omnigent.entities import CompactionData
    from omnigent.stores.conversation_store import SIDE_CHAT_START_LABEL_KEY

    def compaction(item_id: str, response_id: str, summary: str) -> Any:
        data = CompactionData(summary=summary, last_item_id="m", model=None, token_count=1)
        return SimpleNamespace(id=item_id, response_id=response_id, data=data)

    items = [
        compaction("cmp_parent", "resp_parent", "parent's own rollover"),
        compaction("cmp_seed", "rollover_seed_side1", "the seed"),
    ]

    class Store:
        def list_items(self, *_a: Any, **_k: Any) -> Any:
            return SimpleNamespace(data=items, has_more=False, last_id=items[-1].id)

    conv = SimpleNamespace(id="side1", labels={SIDE_CHAT_START_LABEL_KEY: "with_context"})
    assert side_chat_seed_checkpoint(Store(), conv) == ("the seed", "cmp_seed")  # type: ignore[arg-type]


@pytest.mark.parametrize("header_name", ["SIDE_CHAT_SEED_HEADER", "CHECKPOINT_HEADER"])
def test_person_facing_summary_drops_framing_title_and_tool_sections(header_name: str) -> None:
    """A seed reads to the person as its body only, never as the model's framing."""
    from omnigent.context import rollover

    raw = "\n".join(
        [
            getattr(rollover, header_name),
            "",
            "## Context checkpoint — 2026-10-04 10:00 UTC",
            "**Goal**: plan Q4",
            "",
            "## Technical capabilities confirmed",
            "- sys_session_send, sys_os_write",
            "",
            "## Current position / next step",
            "Draft the checklist.",
        ]
    )
    assert person_facing_summary(raw) == (
        "**Goal**: plan Q4\n\n## Current position / next step\nDraft the checklist."
    )


def test_person_facing_summary_reads_a_seed_stored_before_the_marker_prefix() -> None:
    from omnigent.context.rollover import CHECKPOINT_MARKER, SIDE_CHAT_SEED_HEADER

    legacy = SIDE_CHAT_SEED_HEADER.removeprefix(f"{CHECKPOINT_MARKER} ")
    assert person_facing_summary(f"{legacy}\n\nBody") == "Body"
    assert person_facing_summary(None) is None
    assert person_facing_summary(SIDE_CHAT_SEED_HEADER) is None


# ── split_at_latest_compaction ────────────────────────────────────────────


def _split_item(item_id: str, item_type: str = "message", **extra: Any) -> dict[str, Any]:
    return {"id": item_id, "type": item_type, **extra}


def test_split_without_compaction_returns_everything() -> None:
    from omnigent.context.rollover import split_at_latest_compaction

    items = [_split_item("u1"), _split_item("a1")]
    assert split_at_latest_compaction(items) == (items, None)


def test_split_keeps_items_that_landed_between_anchor_and_checkpoint() -> None:
    from omnigent.context.rollover import split_at_latest_compaction

    ckpt = _split_item("c1", "compaction", last_item_id="a1")
    items = [
        _split_item("u1"),
        _split_item("a1"),
        _split_item("u2"),  # turn that ran while the rollover summarized
        _split_item("a2"),
        ckpt,
        _split_item("u3"),
    ]
    after, found = split_at_latest_compaction(items)
    assert found is ckpt
    assert [i["id"] for i in after] == ["u2", "a2", "u3"]


def test_split_with_unknown_anchor_falls_back_to_after_the_checkpoint() -> None:
    from omnigent.context.rollover import split_at_latest_compaction

    ckpt = _split_item("c1", "compaction", last_item_id="compact_boundary_x")
    items = [_split_item("u1"), ckpt, _split_item("u2")]
    after, _ = split_at_latest_compaction(items)
    assert [i["id"] for i in after] == ["u2"]
