"""Unit tests for omnigent.superchat.activity.derive's pure derivation logic.

These build Conversation/ConversationItem objects directly (no store, no
DB) so they stay fast and laptop-friendly; store-backed orchestration
(list_chat_family / list_activities / get_activity, owner scoping) is
covered in test_activity_store.py.
"""

from __future__ import annotations

import json

import pytest

from omnigent.entities import (
    Conversation,
    ConversationItem,
    ErrorData,
    FunctionCallData,
    FunctionCallOutputData,
    MessageData,
)
from omnigent.superchat.activity.derive import (
    ITEMS_SCAN_LIMIT_ENV,
    STATUS_CANCELLED,
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_IN_PROGRESS,
    _activities_for_conversation,
    _resolve_items_scan_limit,
    _sub_agent_status,
    _turn_status,
    is_superside_chat,
    step_title_for_call,
)


def _conv(
    conv_id: str = "conv_1",
    *,
    kind: str = "default",
    title: str | None = None,
    labels: dict[str, str] | None = None,
    live_status: str | None = None,
    sub_agent_name: str | None = None,
    task_summary: str | None = None,
    parent_id: str | None = None,
) -> Conversation:
    return Conversation(
        id=conv_id,
        created_at=1_000,
        updated_at=1_000,
        root_conversation_id=conv_id,
        kind=kind,
        title=title,
        labels=labels or {},
        live_status=live_status,
        sub_agent_name=sub_agent_name,
        task_summary=task_summary,
        parent_conversation_id=parent_id,
    )


def _msg(
    item_id: str,
    role: str,
    text: str,
    *,
    response_id: str = "resp_1",
    created_at: int = 1,
    agent: str | None = None,
    interrupted: bool = False,
    is_system_notice: bool = False,
) -> ConversationItem:
    content = [{"type": "input_text" if role == "user" else "output_text", "text": text}]
    return ConversationItem(
        id=item_id,
        type="message",
        status="completed",
        response_id=response_id,
        created_at=created_at,
        data=MessageData(
            role=role,  # type: ignore[arg-type]
            content=content,
            agent=agent or ("assistant-agent" if role == "assistant" else None),
            interrupted=interrupted,
            is_system_notice=is_system_notice,
        ),
    )


def _call(
    item_id: str,
    name: str,
    arguments: dict[str, object],
    *,
    call_id: str = "call_1",
    response_id: str = "resp_1",
    created_at: int = 2,
) -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="function_call",
        status="completed",
        response_id=response_id,
        created_at=created_at,
        data=FunctionCallData(
            agent="assistant-agent", name=name, arguments=json.dumps(arguments), call_id=call_id
        ),
    )


def _call_output(
    item_id: str,
    output: str,
    *,
    call_id: str = "call_1",
    response_id: str = "resp_1",
    created_at: int = 3,
) -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="function_call_output",
        status="completed",
        response_id=response_id,
        created_at=created_at,
        data=FunctionCallOutputData(call_id=call_id, output=output),
    )


def _error(
    item_id: str,
    message: str,
    *,
    response_id: str = "resp_1",
    created_at: int = 4,
) -> ConversationItem:
    return ConversationItem(
        id=item_id,
        type="error",
        status="completed",
        response_id=response_id,
        created_at=created_at,
        data=ErrorData(source="tool", code="boom", message=message),
    )


class _FakeItemsStore:
    """Minimal ConversationStore stand-in: list_items only."""

    def __init__(
        self, items: list[ConversationItem], titles: dict[str, str] | None = None
    ) -> None:
        self._items = items
        self._titles = titles or {}

    def get_activity_labels(self, response_ids: list[str]) -> dict[str, tuple[str, str | None]]:
        return {rid: (self._titles[rid], None) for rid in response_ids if rid in self._titles}

    def list_items(self, conversation_id: str, limit: int = 1000, order: str = "asc"):
        class _Page:
            def __init__(self, data: list[ConversationItem]) -> None:
                self.data = data

        # Real stores sort by the requested order; this fake's items are
        # constructed chronologically (ascending), so "desc" must reverse
        # them — matching list_activities' newest-first-then-reversed scan.
        data = self._items if order == "asc" else list(reversed(self._items))
        return _Page(data[:limit])


# ── _resolve_items_scan_limit ────────────────────────────────────────────


def test_items_scan_limit_default_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ITEMS_SCAN_LIMIT_ENV, raising=False)
    assert _resolve_items_scan_limit() == 1000


def test_items_scan_limit_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ITEMS_SCAN_LIMIT_ENV, "50")
    assert _resolve_items_scan_limit() == 50


def test_items_scan_limit_ignores_invalid_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(ITEMS_SCAN_LIMIT_ENV, "not-a-number")
    assert _resolve_items_scan_limit() == 1000
    monkeypatch.setenv(ITEMS_SCAN_LIMIT_ENV, "-5")
    assert _resolve_items_scan_limit() == 1000


# ── is_superside_chat ────────────────────────────────────────────────────


def test_is_superside_chat_true_only_for_exact_value() -> None:
    assert is_superside_chat({"omnigent.context.mode": "superside-chat"}) is True
    assert is_superside_chat({"omnigent.context.mode": "rollover"}) is False
    assert is_superside_chat({}) is False
    assert is_superside_chat(None) is False


# ── Turn with tools -> Activity; turn without tools -> no Activity ──────


def test_turn_with_tool_call_becomes_one_activity_with_a_step() -> None:
    conv = _conv(title="Side chat mechanics")
    items = [
        _msg("u1", "user", "research side chat mechanics", created_at=1),
        _call("fc1", "memory_search", {"query": "side chat"}, created_at=2),
        _call_output("fo1", "found 3 notes", created_at=3),
        _msg("a1", "assistant", "Researched side chat mechanics with quotes", created_at=4),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert len(activities) == 1
    activity = activities[0]
    assert activity.kind == "turn"
    assert activity.chat_id == "conv_1"
    assert activity.title == "Research side chat mechanics", "titled by the tidied request"
    assert activity.source == "turn"
    assert activity.summary == "Researched side chat mechanics with quotes"
    assert activity.title_prompt is not None, "a model title is still to be written"
    assert "What was done for it: Searched memory for 'side chat'" in activity.title_prompt
    assert activity.outcome == "Researched side chat mechanics with quotes"
    assert activity.status == STATUS_DONE
    assert activity.started_at == 1
    assert activity.finished_at == 4
    assert len(activity.steps) == 1
    assert activity.steps[0].title == "Searched memory for 'side chat'"
    assert activity.steps[0].detail is None  # not requested


def test_turn_without_tool_call_is_not_an_activity() -> None:
    conv = _conv()
    items = [
        _msg("u1", "user", "hi", created_at=1),
        _msg("a1", "assistant", "hello", created_at=2),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activities == []


def test_turn_step_detail_included_only_when_requested() -> None:
    conv = _conv()
    items = [
        _call("fc1", "memory_search", {"query": "q"}, created_at=1),
        _call_output("fo1", "result text", created_at=2),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=True, super_chat_id=conv.id
    )
    [activity] = activities
    [step] = activity.steps
    assert step.detail is not None
    assert step.detail["call"]["name"] == "memory_search"
    assert step.detail["result"]["content"] == "result text"


# ── Sub-agent conversation -> one Activity ──────────────────────────────


def test_sub_agent_conversation_becomes_one_activity() -> None:
    conv = _conv("conv_child", kind="sub_agent", title="researcher:auth-flow", live_status="idle")
    items = [
        _call("fc1", "memory_search", {"query": "auth"}, created_at=5),
        _call_output("fo1", "ok", created_at=6),
        _msg("a1", "assistant", "Found the auth flow docs", created_at=7),
    ]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.kind == "sub_agent"
    assert activity.id == "sub_agent:conv_child"
    assert activity.title == "auth-flow"
    assert activity.source == "background"
    assert activity.status == STATUS_DONE
    assert activity.outcome == "Found the auth flow docs"
    assert activity.started_at == 5
    assert activity.finished_at == 7


# ── Step title templates ─────────────────────────────────────────────────


def test_step_title_memory_search_with_query() -> None:
    assert step_title_for_call("memory_search", json.dumps({"query": "deadline"})) == (
        "Searched memory for 'deadline'"
    )


def test_step_title_session_history_read() -> None:
    assert step_title_for_call("session_history", json.dumps({"action": "read"})) == (
        "Read earlier messages"
    )


def test_step_title_sys_session_create_with_title() -> None:
    assert step_title_for_call("sys_session_create", json.dumps({"title": "auth-flow"})) == (
        "Launched a sub-agent 'auth-flow'"
    )


def test_step_title_fallback_for_unknown_tool() -> None:
    assert step_title_for_call("web_search", "{}") == "Used web_search"


def test_step_title_handles_malformed_arguments() -> None:
    assert step_title_for_call("memory_search", "not json") == "Searched memory"


# ── Status mapping ────────────────────────────────────────────────────────


def test_turn_status_error_item_is_failed() -> None:
    conv = _conv(live_status="idle")
    group = [_call("fc1", "t", {}), _error("e1", "boom")]
    assert _turn_status(conv, group, is_latest_group=True) == STATUS_FAILED


def test_turn_status_interrupted_message_is_cancelled() -> None:
    conv = _conv(live_status="idle")
    group = [
        _call("fc1", "t", {}),
        _msg("a1", "assistant", "partial", interrupted=True),
    ]
    assert _turn_status(conv, group, is_latest_group=True) == STATUS_CANCELLED


def test_turn_status_latest_group_running_is_in_progress() -> None:
    conv = _conv(live_status="running")
    group = [_call("fc1", "t", {})]
    assert _turn_status(conv, group, is_latest_group=True) == STATUS_IN_PROGRESS


def test_turn_status_older_group_ignores_live_status() -> None:
    conv = _conv(live_status="running")
    group = [_call("fc1", "t", {}), _msg("a1", "assistant", "done")]
    assert _turn_status(conv, group, is_latest_group=False) == STATUS_DONE


def test_sub_agent_status_failed() -> None:
    conv = _conv(kind="sub_agent", live_status="failed")
    assert _sub_agent_status(conv) == STATUS_FAILED


def test_sub_agent_status_in_progress() -> None:
    conv = _conv(kind="sub_agent", live_status="running")
    assert _sub_agent_status(conv) == STATUS_IN_PROGRESS


def test_sub_agent_status_cancelled_when_closed_before_any_turn() -> None:
    conv = _conv(
        kind="sub_agent",
        live_status=None,
        labels={"omnigent.closed": "true"},
    )
    assert _sub_agent_status(conv) == STATUS_CANCELLED


def test_sub_agent_status_done_when_closed_after_finishing() -> None:
    conv = _conv(
        kind="sub_agent",
        live_status="idle",
        labels={"omnigent.closed": "true"},
    )
    assert _sub_agent_status(conv) == STATUS_DONE


def test_sub_agent_status_done_when_idle_and_not_closed() -> None:
    conv = _conv(kind="sub_agent", live_status="idle")
    assert _sub_agent_status(conv) == STATUS_DONE


_LAUNCHING = {"omnigent.subagent.launching": "true"}


def test_sub_agent_status_launching_helper_reads_in_progress_not_done() -> None:
    conv = _conv(kind="sub_agent", live_status=None, labels=_LAUNCHING)
    assert _sub_agent_status(conv, [], now=conv.created_at + 5) == STATUS_IN_PROGRESS


def test_sub_agent_status_helper_that_never_reports_after_launch_failed_to_start() -> None:
    conv = _conv(kind="sub_agent", live_status=None, labels=_LAUNCHING)
    assert _sub_agent_status(conv, [], now=conv.created_at + 3_600) == STATUS_FAILED


def test_sub_agent_status_launch_failure_edge_reads_failed_at_once() -> None:
    conv = _conv(kind="sub_agent", live_status="failed", labels=_LAUNCHING)
    assert _sub_agent_status(conv, [], now=conv.created_at + 5) == STATUS_FAILED


def test_sub_agent_status_launched_helper_follows_its_reported_status() -> None:
    conv = _conv(kind="sub_agent", live_status="running", labels=_LAUNCHING)
    assert _sub_agent_status(conv, [], now=conv.created_at + 3_600) == STATUS_IN_PROGRESS


def test_sub_agent_status_unlabelled_silent_helper_stays_done() -> None:
    conv = _conv(kind="sub_agent", live_status=None)
    assert _sub_agent_status(conv, [], now=conv.created_at + 5) == STATUS_DONE


def test_sub_agent_status_helper_that_replied_without_status_is_done() -> None:
    conv = _conv(kind="sub_agent", live_status=None, labels=_LAUNCHING)
    items = [_msg("a1", "assistant", "All done")]
    assert _sub_agent_status(conv, items, now=conv.created_at + 5) == STATUS_DONE


def test_failed_launch_says_so_in_plain_words() -> None:
    conv = _conv(kind="sub_agent", title="researcher:japan", labels=_LAUNCHING)
    [activity] = _activities_for_conversation(
        _FakeItemsStore([]), conv, include_step_detail=False, super_chat_id="conv_root"
    )
    assert activity.status == STATUS_FAILED
    assert activity.outcome == "Could not get started"


def test_sub_agent_activity_names_the_chat_that_started_it() -> None:
    conv = _conv(
        "conv_child",
        kind="sub_agent",
        title="researcher:japan",
        live_status="running",
        parent_id="conv_parent",
    )
    [activity] = _activities_for_conversation(
        _FakeItemsStore([_call("fc1", "memory_search", {"query": "japan"})]),
        conv,
        include_step_detail=False,
        super_chat_id="conv_root",
    )
    assert activity.parent_chat_id == "conv_parent"
    assert activity.status == STATUS_IN_PROGRESS


def test_system_started_turn_is_titled_by_the_chat() -> None:
    conv = _conv(title="Side chat mechanics")
    items = [
        _msg("u1", "user", "[System: sub-agent researcher/x finished (completed)]", created_at=1),
        _call("fc1", "sys_read_inbox", {}, created_at=2),
        _call_output("fo1", "delivered", created_at=3),
        _msg("a1", "assistant", "Here is the result", created_at=4),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activities[0].title == "Here is the result", "named by what the turn said"
    assert activities[0].title_prompt is not None


def test_flagged_notice_without_the_legacy_prefix_is_still_system_started() -> None:
    # A wake notice is recognised by the runtime's flag, not by how its text opens.
    conv = _conv(title="Side chat mechanics")
    items = [
        _msg("u1", "user", "Researcher finished: the result", created_at=1, is_system_notice=True),
        _call("fc1", "sys_read_inbox", {}, created_at=2),
        _call_output("fo1", "delivered", created_at=3),
        _msg("a1", "assistant", "Here is the result", created_at=4),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activities[0].title == "Here is the result"


def test_turn_titled_by_request_stored_outside_its_response_group() -> None:
    conv = _conv(title="Main chat")
    items = [
        _msg("u1", "user", "check the Q4 totals", created_at=1, response_id="resp_user"),
        _call("fc1", "memory_search", {"query": "q4"}, created_at=2, response_id="resp_2"),
        _call_output("fo1", "found", created_at=3, response_id="resp_2"),
        _msg("a1", "assistant", "Totals match", created_at=4, response_id="resp_2"),
    ]
    activities = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activities[0].title == "Check the Q4 totals"


# ── model-written titles, sources, summaries ─────────────────────────────


def _tool_turn_items(request: str = "yo what's tesla stock price?") -> list[ConversationItem]:
    return [
        _msg("u1", "user", request, created_at=1, response_id="resp_1"),
        _call("fc1", "web_search", {"query": "tesla stock"}, created_at=2, response_id="resp_1"),
        _call_output("fo1", "ok", created_at=3, response_id="resp_1"),
        _msg(
            "a1",
            "assistant",
            "**Tesla** is at $240. It rose 2% today.",
            created_at=4,
            response_id="resp_1",
        ),
    ]


def test_stored_title_replaces_the_fallback_and_ends_the_title_job() -> None:
    conv = _conv()
    store = _FakeItemsStore(_tool_turn_items(), titles={"resp_1": "Check Tesla's latest price"})
    [activity] = _activities_for_conversation(
        store, conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.title == "Check Tesla's latest price"
    # Titled but not yet summarised: the result is still to be written up by the model.
    assert activity.title_prompt is not None
    assert "Result:\n**Tesla** is at $240." in activity.title_prompt
    assert activity.summary == "Tesla is at $240."


def test_stored_title_and_summary_end_the_label_job() -> None:
    conv = _conv()
    store = _FakeItemsStore(_tool_turn_items(), titles={"resp_1": "Check Tesla's latest price"})
    store.get_activity_labels = lambda ids: dict.fromkeys(  # type: ignore[method-assign]
        ids, ("Check Tesla's latest price", "Tesla trades at $240 today")
    )
    [activity] = _activities_for_conversation(
        store, conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.title_prompt is None
    assert activity.summary == "Tesla trades at $240 today"


def test_fallback_title_drops_greetings_and_the_question_mark() -> None:
    conv = _conv()
    [activity] = _activities_for_conversation(
        _FakeItemsStore(_tool_turn_items()), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.title == "What's tesla stock price"


def test_a_side_chat_turn_has_the_side_chat_source() -> None:
    conv = _conv("conv_side")
    [activity] = _activities_for_conversation(
        _FakeItemsStore(_tool_turn_items()),
        conv,
        include_step_detail=False,
        super_chat_id="conv_super",
    )
    assert activity.source == "side_chat"


def test_in_progress_turn_carries_only_its_latest_steps_call() -> None:
    conv = _conv(live_status="running")
    items = [
        _msg("u1", "user", "look up tesla", created_at=1, response_id="resp_1"),
        _call("fc1", "web_search", {"query": "a"}, created_at=2, response_id="resp_1"),
        _call("fc2", "web_search", {"query": "b"}, created_at=3, response_id="resp_1"),
    ]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.status == STATUS_IN_PROGRESS
    assert activity.summary is None
    assert activity.steps[0].detail is None
    assert activity.steps[1].detail is not None and "call" in activity.steps[1].detail


def test_scheduled_helper_shows_its_task_name_without_the_collision_suffix() -> None:
    conv = _conv(
        "conv_child",
        kind="sub_agent",
        title="analyst:Study (Oct 03 07:00 UTC) 1a2b3c4d",
        labels={"omnigent.subagent.scheduled_task_id": "task_1"},
        live_status="idle",
        sub_agent_name="analyst",
    )
    items = [
        _msg("u1", "user", "This is the person's daily study. You prepare...", created_at=1),
        _msg("a1", "assistant", "Nothing new.", created_at=2),
    ]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id="conv_super"
    )
    assert activity.title == "Studied your recent work"
    assert activity.source == "scheduled"
    assert activity.title_prompt is not None
    assert activity.title_prompt.endswith("Result:\nNothing new.")


def test_goal_helper_and_followed_topic_titles() -> None:
    labels = {"omnigent.subagent.scheduled_task_id": "task_1"}
    topic = _conv("conv_a", kind="sub_agent", title="researcher:AI agent launches", labels=labels)
    goal = _conv(
        "conv_b",
        kind="sub_agent",
        title="goal:Run a half marathon",
        labels=labels,
        sub_agent_name="goal",
    )
    [topic_activity] = _activities_for_conversation(
        _FakeItemsStore([]), topic, include_step_detail=False, super_chat_id="conv_super"
    )
    [goal_activity] = _activities_for_conversation(
        _FakeItemsStore([]), goal, include_step_detail=False, super_chat_id="conv_super"
    )
    assert (topic_activity.title, topic_activity.source) == ("AI agent launches", "scheduled")
    assert (goal_activity.title, goal_activity.source) == ("Run a half marathon", "goal")


def test_task_summary_names_a_background_helper() -> None:
    conv = _conv(
        "conv_child",
        kind="sub_agent",
        title="researcher:researcher-1",
        task_summary="Check Tesla's latest price",
    )
    items = [_msg("u1", "user", "Please look up the Tesla price", created_at=1)]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id="conv_super"
    )
    assert activity.title == "Check Tesla's latest price"
    assert activity.title_prompt is None


def test_generic_helper_title_falls_back_to_the_delegated_task_and_asks_for_a_title() -> None:
    conv = _conv("conv_child", kind="sub_agent", title="researcher:researcher-1")
    items = [_msg("u1", "user", "Please look up the Tesla price", created_at=1)]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id="conv_super"
    )
    assert activity.title == "Look up the Tesla price"
    assert activity.title_prompt == "Request to name:\nPlease look up the Tesla price"


def test_a_machine_readable_reply_gives_no_summary_and_no_title() -> None:
    conv = _conv(title="Side chat mechanics")
    items = [
        _msg("u1", "user", "[System: sub-agent analyst/x finished (completed)]", created_at=1),
        _call("fc1", "sys_read_inbox", {}, created_at=2),
        _msg("a1", "assistant", '```json\n{"kind": "study"}\n```', created_at=4),
    ]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id=conv.id
    )
    assert activity.summary is None
    assert activity.title == "Side chat mechanics"
    assert activity.title_prompt is None


def test_a_scheduled_helper_without_a_usable_name_is_named_from_its_task() -> None:
    conv = _conv(
        "conv_child",
        kind="sub_agent",
        title="researcher:researcher-2",
        labels={"omnigent.subagent.scheduled_task_id": "task_1"},
    )
    items = [_msg("u1", "user", "Track new AI agent launches every Monday", created_at=1)]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id="conv_super"
    )
    assert activity.title == "Track new AI agent launches every Monday"
    assert activity.source == "scheduled"
    assert activity.title_prompt is not None


# ── feed filtering and housekeeping grouping ─────────────────────────────


def _row(
    id_: str,
    *,
    kind: str = "turn",
    source: str = "turn",
    started_at: int = 1_000,
    finished_at: int | None = 1_005,
    tools: tuple[str, ...] = ("a",),
    title: str = "T",
):
    from omnigent.superchat.activity.derive import STATUS_DONE, Activity, Step

    return Activity(
        id=id_,
        kind=kind,
        chat_id="c",
        title=title,
        outcome=None,
        status=STATUS_DONE,
        started_at=started_at,
        finished_at=finished_at,
        steps=[
            Step(item_id=f"s{i}", title=t, created_at=started_at, tool=t)
            for i, t in enumerate(tools)
        ],
        source=source,
    )


def test_feed_omits_quick_turns_and_keeps_real_work() -> None:
    from omnigent.superchat.activity.derive import _feed

    rows = _feed(
        [
            _row("quick"),
            _row("steps", tools=("a", "b", "c")),
            _row("browser", tools=("browser_navigate",)),
            _row("one_search", tools=("web_search",)),
            _row("memory_only", tools=("memory_search",)),
            _row("slow", finished_at=1_061),
            _row("helper", kind="sub_agent", source="background", tools=()),
            _row("goal", kind="sub_agent", source="goal", tools=()),
        ],
        None,
    )
    assert {r.id for r in rows} == {"steps", "browser", "one_search", "slow", "helper", "goal"}


def test_housekeeping_is_one_row_per_local_day() -> None:
    from omnigent.superchat.activity.derive import HOUSEKEEPING_TITLE, _feed

    # 2026-10-05 02:30 UTC and 2026-10-05 03:30 UTC are still Oct 4 in New York.
    base = 1_791_167_400
    runs = [
        _row(
            f"h{i}",
            kind="sub_agent",
            source="housekeeping",
            started_at=base + i * 3600,
            tools=(),
            title="Daily note (Oct 05 02:30 UTC)",
        )
        for i in range(2)
    ] + [_row("h_next", kind="sub_agent", source="housekeeping", started_at=base + 86_400 * 2)]
    rows = _feed(runs, "America/New_York")
    upkeep = [r for r in rows if r.source == "housekeeping"]
    assert len(upkeep) == 2
    first = min(upkeep, key=lambda r: r.started_at)
    assert (first.title, first.summary) == (HOUSEKEEPING_TITLE, "2 updates")
    assert [s.title for s in first.steps] == ["Daily note", "Daily note"]
    assert "UTC" not in "".join(s.title for s in first.steps)


def test_adhoc_helper_is_housekeeping_and_its_title_has_no_utc_suffix() -> None:
    conv = _conv(
        "conv_child",
        kind="sub_agent",
        title="dreamer:Dreaming (Oct 04 22:53 UTC)",
        labels={"omnigent.subagent.adhoc": "task_1"},
        live_status="idle",
        sub_agent_name="dreamer",
    )
    items = [
        _msg("u1", "user", "Tidy memory", created_at=1),
        _msg("a1", "assistant", "ok", created_at=2),
    ]
    [activity] = _activities_for_conversation(
        _FakeItemsStore(items), conv, include_step_detail=False, super_chat_id="conv_super"
    )
    assert activity.source == "housekeeping"
    assert "UTC" not in activity.title
