"""Unit tests for ``omnigent.superchat.subagents`` (slice S3).

Pure decision logic only — no DB, no server, no live calls. The async glue
that calls these from ``omnigent/runner/tool_dispatch.py`` and
``omnigent/runner/app.py`` is covered by the runner-level dispatch and wake
tests.
"""

from __future__ import annotations

import logging

import pytest

from omnigent.superchat.subagents import (
    DEFAULT_CONCURRENCY_CAP,
    DEFAULT_CONCURRENCY_ENV,
    count_live_children,
    format_subagent_wake_notice_with_result,
    is_live_child_row,
    prepend_memory_profile,
    refuse_subagent_concurrency,
    refuse_subagent_dispatch_override,
    refuse_subagent_nesting,
    resolve_default_concurrency_cap,
    resolve_helper_dispatch,
    resolve_scheduled_helper,
    resolve_wake_target,
)

# ── resolve_default_concurrency_cap ────────────────────────────────────────


def test_default_concurrency_cap_is_ten_when_unset() -> None:
    assert resolve_default_concurrency_cap(env={}) == DEFAULT_CONCURRENCY_CAP == 10


def test_default_concurrency_cap_reads_env_override() -> None:
    assert resolve_default_concurrency_cap(env={DEFAULT_CONCURRENCY_ENV: "3"}) == 3


def test_default_concurrency_cap_falls_back_on_garbage() -> None:
    assert resolve_default_concurrency_cap(env={DEFAULT_CONCURRENCY_ENV: "nope"}) == 10
    assert resolve_default_concurrency_cap(env={DEFAULT_CONCURRENCY_ENV: "0"}) == 10
    assert resolve_default_concurrency_cap(env={DEFAULT_CONCURRENCY_ENV: "-1"}) == 10


# ── is_live_child_row / count_live_children ────────────────────────────────


def test_is_live_child_row_busy_is_live() -> None:
    assert is_live_child_row({"busy": True, "current_task_status": None}) is True


def test_is_live_child_row_queued_or_in_progress_is_live() -> None:
    assert is_live_child_row({"busy": False, "current_task_status": "queued"}) is True
    assert is_live_child_row({"busy": False, "current_task_status": "in_progress"}) is True


def test_is_live_child_row_completed_is_not_live() -> None:
    assert is_live_child_row({"busy": False, "current_task_status": "completed"}) is False


def test_is_live_child_row_closed_is_never_live() -> None:
    row = {
        "busy": True,
        "current_task_status": "in_progress",
        "labels": {"omnigent.closed": "true"},
        "title": "researcher:auth",
    }
    assert is_live_child_row(row) is False


def test_count_live_children_filters_by_type() -> None:
    rows = [
        {"tool": "researcher", "busy": True},
        {"tool": "researcher", "busy": False, "current_task_status": "completed"},
        {"tool": "drafter", "busy": True},
    ]
    assert count_live_children(rows, agent_type="researcher") == 1
    assert count_live_children(rows) == 2


# ── refuse_subagent_concurrency ─────────────────────────────────────────────


def test_concurrency_allows_under_both_caps() -> None:
    assert (
        refuse_subagent_concurrency(
            live_count_of_type=1, live_count_total=1, type_cap=3, default_cap=10
        )
        is None
    )


def test_concurrency_refuses_at_type_cap() -> None:
    reason = refuse_subagent_concurrency(
        live_count_of_type=2, live_count_total=2, type_cap=2, default_cap=10
    )
    assert reason is not None
    assert "2/2" in reason


def test_concurrency_refuses_at_default_cap_even_under_type_cap() -> None:
    reason = refuse_subagent_concurrency(
        live_count_of_type=1, live_count_total=10, type_cap=5, default_cap=10
    )
    assert reason is not None
    assert "10/10" in reason


def test_concurrency_no_type_cap_only_default_applies() -> None:
    assert (
        refuse_subagent_concurrency(
            live_count_of_type=4, live_count_total=4, type_cap=None, default_cap=10
        )
        is None
    )


# ── refuse_subagent_nesting ──────────────────────────────────────────────────


def test_nesting_allows_the_chat_itself() -> None:
    assert refuse_subagent_nesting(caller_kind="default", parent_kind=None) is None


def test_nesting_allows_a_direct_subagent_of_the_chat() -> None:
    assert refuse_subagent_nesting(caller_kind="sub_agent", parent_kind="default") is None
    assert refuse_subagent_nesting(caller_kind="sub_agent", parent_kind=None) is None


def test_nesting_refuses_a_coordinators_child() -> None:
    reason = refuse_subagent_nesting(caller_kind="sub_agent", parent_kind="sub_agent")
    assert reason is not None
    assert "nesting cap" in reason


# ── refuse_subagent_dispatch_override ───────────────────────────────────────


def test_dispatch_override_allows_neither_override() -> None:
    assert refuse_subagent_dispatch_override(model=None, reasoning_effort=None) is None


def test_dispatch_override_refuses_model() -> None:
    reason = refuse_subagent_dispatch_override(model="claude-opus-4-7", reasoning_effort=None)
    assert reason is not None
    assert "model" in reason


def test_dispatch_override_refuses_reasoning_effort() -> None:
    reason = refuse_subagent_dispatch_override(model=None, reasoning_effort="high")
    assert reason is not None
    assert "reasoning_effort" in reason


# ── resolve_helper_dispatch ─────────────────────────────────────────────────

_ENV = {"OMNIGENT_HELPER_MODEL_FAST": "fast-id", "OMNIGENT_HELPER_MODEL_STRONG": "strong-id"}


def test_helper_dispatch_without_a_choice_inherits() -> None:
    assert resolve_helper_dispatch(model=None, reasoning_effort=None, env={}) == (None, None)


def test_helper_dispatch_maps_fast_and_strong_from_config() -> None:
    assert resolve_helper_dispatch(model="fast", reasoning_effort="low", env=_ENV) == (
        "fast-id",
        "low",
    )
    assert resolve_helper_dispatch(model="strong", reasoning_effort="high", env=_ENV) == (
        "strong-id",
        "high",
    )


def test_helper_dispatch_with_nothing_configured_inherits_the_parent_model() -> None:
    for choice in ("fast", "strong"):
        assert resolve_helper_dispatch(model=choice, reasoning_effort=None, env={})[0] is None
    # No product's model variable is read: only the generic helper variables count.
    env = {"NOVA_CLAUDE_MODEL": "muse-model"}
    assert resolve_helper_dispatch(model="strong", reasoning_effort=None, env=env)[0] is None


def test_helper_dispatch_rejects_any_other_model() -> None:
    with pytest.raises(ValueError, match="'fast' or 'strong'"):
        resolve_helper_dispatch(model="claude-opus-4-7", reasoning_effort=None, env=_ENV)


def test_helper_dispatch_rejects_unknown_effort() -> None:
    with pytest.raises(ValueError, match="reasoning_effort"):
        resolve_helper_dispatch(model="fast", reasoning_effort="ultra", env=_ENV)


def test_helper_dispatch_on_a_multi_model_harness_ignores_the_global_ids() -> None:
    # A pi Helper under a GPT-class parent must inherit it, not get the global Claude ids.
    for choice in ("fast", "strong"):
        assert resolve_helper_dispatch(
            model=choice, reasoning_effort=None, harness="pi", env=_ENV
        ) == (None, None)


def test_helper_dispatch_on_a_multi_model_harness_reads_its_own_scoped_ids() -> None:
    env = {**_ENV, "OMNIGENT_HELPER_MODEL_FAST_PI": "pi-fast-id"}
    assert resolve_helper_dispatch(model="fast", reasoning_effort=None, harness="pi", env=env) == (
        "pi-fast-id",
        None,
    )
    # strong has no pi id: inherit, never the global one.
    assert (
        resolve_helper_dispatch(model="strong", reasoning_effort=None, harness="pi", env=env)[0]
        is None
    )


def test_helper_dispatch_on_a_single_vendor_harness_keeps_the_global_ids() -> None:
    assert resolve_helper_dispatch(
        model="fast", reasoning_effort=None, harness="claude-sdk", env=_ENV
    ) == ("fast-id", None)
    scoped = {**_ENV, "OMNIGENT_HELPER_MODEL_FAST_CLAUDE_SDK": "scoped-id"}
    assert resolve_helper_dispatch(
        model="fast", reasoning_effort=None, harness="claude-sdk", env=scoped
    ) == ("scoped-id", None)


def test_scheduled_helper_follows_the_bundles_harness_for_its_model() -> None:
    assert resolve_scheduled_helper("goal", None, env=_ENV, harness="pi") == ("goal", None)
    assert resolve_scheduled_helper("goal", None, env=_ENV, harness="claude-sdk") == (
        "goal",
        "fast-id",
    )


# ── memory_profile_for / prepend_memory_profile ─────────────────────────────


def test_prepend_memory_profile_is_a_noop_without_a_profile() -> None:
    assert prepend_memory_profile("do the thing", None) == "do the thing"
    assert prepend_memory_profile("do the thing", "") == "do the thing"


def test_prepend_memory_profile_prepends_when_present() -> None:
    result = prepend_memory_profile("do the thing", "prefers concise answers")
    assert result.startswith("prefers concise answers\n\n")
    assert result.endswith("do the thing")


# ── format_subagent_wake_notice_with_result ─────────────────────────────────


def test_wake_notice_inlines_short_result() -> None:
    notice = format_subagent_wake_notice_with_result(
        agent="researcher",
        title="auth",
        status="completed",
        child_session_id="conv_child123",
        result_text="the vault key rotated on March 3",
    )
    assert "researcher/auth" in notice
    assert "completed" in notice
    assert "the vault key rotated on March 3" in notice


def test_wake_notice_tells_the_muse_to_finish_the_original_request() -> None:
    notice = format_subagent_wake_notice_with_result(
        agent="researcher",
        title="auth",
        status="completed",
        child_session_id="conv_child123",
        result_text="r",
    )
    assert "complete what the person originally asked for" in notice
    assert "not a status update" in notice
    assert "still open in one line" in notice
    assert "unrelated topics" in notice
    assert notice.startswith("[System:") and notice.endswith("]")


def test_wake_notice_handles_missing_result() -> None:
    notice = format_subagent_wake_notice_with_result(
        agent="researcher",
        title="auth",
        status="completed",
        child_session_id="conv_child123",
        result_text=None,
    )
    assert "(no output)" in notice


def test_wake_notice_truncates_and_points_at_full_history() -> None:
    long_text = "x" * 50
    notice = format_subagent_wake_notice_with_result(
        agent="researcher",
        title="auth",
        status="completed",
        child_session_id="conv_child123",
        result_text=long_text,
        max_chars=10,
    )
    assert "x" * 10 in notice
    assert "truncated" in notice
    assert "conv_child123" in notice
    assert long_text not in notice


# ── resolve_wake_target ──────────────────────────────────────────────────────


def test_wake_target_unchanged_for_a_live_chat() -> None:
    target, note = resolve_wake_target(
        parent_id="conv_parent",
        archived=False,
        is_side_chat=True,
        fork_source_id="conv_super",
    )
    assert target == "conv_parent"
    assert note is None


def test_wake_target_unchanged_when_not_a_side_chat() -> None:
    # The Super Chat itself is never archived-and-redirected.
    target, note = resolve_wake_target(
        parent_id="conv_super", archived=True, is_side_chat=False, fork_source_id=None
    )
    assert target == "conv_super"
    assert note is None


def test_wake_target_redirects_archived_side_chat() -> None:
    target, note = resolve_wake_target(
        parent_id="conv_side",
        archived=True,
        is_side_chat=True,
        fork_source_id="conv_super",
    )
    assert target == "conv_super"
    assert note is not None
    assert "conv_side" in note
    assert "archived Side Chat" in note


def test_wake_target_unchanged_when_fork_source_unknown(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Delivery still goes to the archived chat (no Super Chat to redirect
    to), but this must not happen silently — the chat is hidden from the
    user's list, so a missing fork_source label is logged."""
    with caplog.at_level(logging.WARNING, logger="omnigent.superchat.subagents"):
        target, note = resolve_wake_target(
            parent_id="conv_side", archived=True, is_side_chat=True, fork_source_id=None
        )
    assert target == "conv_side"
    assert note is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "conv_side" in warnings[0].getMessage()


# ── resolve_scheduled_helper ────────────────────────────────────────────────


@pytest.mark.parametrize("retired", ["researcher", "analyst", "drafter"])
def test_retired_types_run_as_worker_on_the_fast_model(retired: str) -> None:
    assert resolve_scheduled_helper(retired, None, env=_ENV) == ("worker", "fast-id")


def test_declared_types_keep_their_name_and_background_runs_fast() -> None:
    assert resolve_scheduled_helper("goal", None, env=_ENV) == ("goal", "fast-id")
    assert resolve_scheduled_helper("worker", "strong", env=_ENV) == ("worker", "strong-id")


def test_a_stored_model_id_is_left_alone() -> None:
    assert resolve_scheduled_helper("worker", "some-model", env=_ENV) == ("worker", "some-model")
