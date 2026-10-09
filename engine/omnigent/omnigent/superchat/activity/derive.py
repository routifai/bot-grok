"""Activity Feed derivation for ``superside-chat`` sessions.

An **Activity** is never stored: it is derived on read from existing
conversations and items — a chat turn (Super Chat / Side Chat) that
included at least one tool call, or a whole Sub-agent session. See
``rollover/CONTEXT.md`` (Activity, Activity Feed, Step) and
``rollover/SUPERSIDE-CHAT-PLAN.md`` (slice S5).

Reuses ``_project_activity_item`` from ``omnigent.tools.builtins.spawn``
for step/detail projection, and ``list_related_chats`` from
``omnigent.context.rollover`` for Side Chat discovery, rather than
re-implementing either.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from omnigent.context.labels import (
    ADHOC_HELPER_LABEL_KEY,
    SCHEDULED_HELPER_LABEL_KEY,
)
from omnigent.entities import Conversation, ConversationItem, MessageData
from omnigent.entities.conversation import is_system_notice
from omnigent.stores.conversation_store import ConversationStore
from omnigent.superchat.activity.titles import (
    ACTIVITY_TITLE_INSTRUCTIONS,
    clean_generated_label,
    is_generic_title,
    scheduled_display_title,
    scrub_internal_words,
    split_generated_label,
    strip_fire_suffix,
    strip_reply_filler,
    tidy_request_title,
)
from omnigent.superchat.family.tree import (  # noqa: F401  (re-exported: the family reads live in core)
    STATUS_CANCELLED,
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_IN_PROGRESS,
    is_helper_live,
    last_assistant_text,
    list_chat_family,
    list_chat_roots,
    message_text,
    resolve_super_chat_id,
    sub_agent_status,
)
from omnigent.superchat.titles import STRUCTURED_TEXT, one_line_summary, truncate
from omnigent.superchat.work_tools import is_work_tool
from omnigent.tools.builtins.spawn import _project_activity_item
from omnigent.util.session_lifecycle import title_without_closed_marker

if TYPE_CHECKING:
    from omnigent.server.background_session_titles import BackgroundSessionTitleCoordinator

KIND_TURN = "turn"
KIND_SUB_AGENT = "sub_agent"

#: What an Activity is, for the icon beside it: ``kind`` says how it is stored
#: (and keys its id); ``source`` says where the work came from.
SOURCE_TURN = "turn"
SOURCE_SIDE_CHAT = "side_chat"
SOURCE_BACKGROUND = "background"
SOURCE_SCHEDULED = "scheduled"
SOURCE_GOAL = "goal"
#: Quiet upkeep (daily note, Dreaming, People): grouped into one row per local day.
SOURCE_HOUSEKEEPING = "housekeeping"
HOUSEKEEPING_PREFIX = "housekeeping"
HOUSEKEEPING_TITLE = "Kept your notes up to date"
#: A conversation turn is shown only when it did real work beyond a quick answer.
_MIN_TURN_STEPS = 3
_MIN_TURN_SECONDS = 60
_GOAL_AGENT_TYPE = "goal"

#: Env var overriding the per-chat Activity Feed items-scan limit below.
ITEMS_SCAN_LIMIT_ENV = "OMNIGENT_ACTIVITY_ITEMS_SCAN_LIMIT"

# A feed covering more items than this per chat only sees the newest
# _ITEMS_SCAN_LIMIT (oldest history is what gets truncated, never the
# current turn) — generous enough for ordinary use while keeping one
# page-fetch's cost bounded.
_ITEMS_SCAN_LIMIT = 1000


def _resolve_items_scan_limit() -> int:
    """Resolve the per-chat Activity Feed items-scan limit.

    Reads :data:`ITEMS_SCAN_LIMIT_ENV`, default :data:`_ITEMS_SCAN_LIMIT`. A
    missing, non-integer, or non-positive value falls back to the default.
    """
    raw = os.environ.get(ITEMS_SCAN_LIMIT_ENV)
    if raw is None:
        return _ITEMS_SCAN_LIMIT
    try:
        value = int(raw)
    except ValueError:
        return _ITEMS_SCAN_LIMIT
    return value if value > 0 else _ITEMS_SCAN_LIMIT


_DEFAULT_LIMIT = 20
_MAX_LIMIT = 100
_OUTCOME_MAX_CHARS = 140
_TITLE_MAX_CHARS = 80
_TITLE_PROMPT_REQUEST_CHARS = 700
_TITLE_PROMPT_STEPS = 6
_TITLE_PROMPT_RESULT_CHARS = 600
#: A feed read starts at most this many model-written titles (newest first); the
#: rest follow on later reads, so an old, untitled history fills in gradually.
_TITLE_JOBS_PER_READ = 8


@dataclass(frozen=True)
class Step:
    """One action within an Activity, in plain language.

    :param item_id: The underlying ``function_call`` item's id.
    :param title: Plain-language description, e.g. ``"Searched memory for
        'deadline'"``.
    :param created_at: Unix epoch timestamp of the call.
    :param tool: The tool name invoked, e.g. ``"memory_search"``.
    :param detail: The call's arguments and matching output, capped —
        populated only when the Activity is read in full (not on the
        list/feed view).
    """

    item_id: str
    title: str
    created_at: int
    tool: str | None = None
    detail: dict[str, Any] | None = None


@dataclass(frozen=True)
class Activity:
    """One unit of multi-step work: a chat turn or a Sub-agent session.

    :param id: Opaque id, e.g. ``"turn:conv_abc:resp_xyz"`` or
        ``"sub_agent:conv_child"``.
    :param kind: ``"turn"`` or ``"sub_agent"``.
    :param chat_id: The conversation this Activity happened in (the Super
        Chat / Side Chat for a turn; the sub-agent's own conversation for a
        sub-agent Activity).
    :param source: Where the work came from: :data:`SOURCE_TURN`,
        :data:`SOURCE_SIDE_CHAT`, :data:`SOURCE_BACKGROUND`,
        :data:`SOURCE_SCHEDULED` or :data:`SOURCE_GOAL`.
    :param title: Short task title: model-written once generated, else the
        request tidied (see :mod:`omnigent.superchat.activity.titles`).
    :param outcome: One-line outcome, or ``None`` when nothing to report yet.
    :param summary: A short one-line gist of the outcome for the feed row, or
        ``None`` while in progress (the live Step stands in) or when there is none.
    :param title_prompt: Set only while a model-written title or result summary is still
        missing: the text to write them from. Never serialized.
    :param stored_summary: The model-written result summary, once stored. Never serialized.
    :param status: One of :data:`STATUS_IN_PROGRESS`, :data:`STATUS_DONE`,
        :data:`STATUS_FAILED`, :data:`STATUS_CANCELLED`.
    :param started_at: Unix epoch timestamp of the first item.
    :param finished_at: Unix epoch timestamp of the last item, or ``None``
        while still in progress.
    :param steps: The Activity's Steps, chronological.
    :param parent_chat_id: For a Sub-agent, the chat that started it (the Super Chat, a
        Side Chat, or another Sub-agent when it is a sub-worker); ``None`` for a turn.
    """

    id: str
    kind: str
    chat_id: str
    title: str
    outcome: str | None
    status: str
    started_at: int
    finished_at: int | None
    steps: list[Step] = field(default_factory=list)
    source: str = SOURCE_TURN
    summary: str | None = None
    title_prompt: str | None = None
    stored_summary: str | None = None
    parent_chat_id: str | None = None


def step_title_for_call(tool_name: str, raw_arguments: str) -> str:
    """Deterministic, plain-language title for one tool call.

    A small set of named templates covers the tools called out in the
    plan; everything else falls back to ``"Used <tool>"``. No LLM call.

    :param tool_name: The invoked tool's name, e.g. ``"memory_search"``.
    :param raw_arguments: The call's JSON-encoded arguments string.
    :returns: A one-line, user-facing description.
    """
    args = _args_dict(raw_arguments)
    if tool_name == "memory_search":
        query = args.get("query") or args.get("q")
        return f"Searched memory for '{query}'" if query else "Searched memory"
    if tool_name == "session_history":
        action = args.get("action")
        if action == "read":
            return "Read earlier messages"
        if action == "list_chats":
            return "Listed side chats"
        return "Used session_history"
    if tool_name == "sys_session_create":
        title = args.get("title")
        return f"Launched a sub-agent '{title}'" if title else "Launched a sub-agent"
    if tool_name == "sys_session_send":
        title = args.get("title")
        return (
            f"Sent a message to sub-agent '{title}'" if title else "Sent a message to a sub-agent"
        )
    return f"Used {tool_name}"


def _args_dict(raw_arguments: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw_arguments)
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _first_user_message(items: list[ConversationItem]) -> ConversationItem | None:
    for item in items:
        if item.type == "message" and getattr(item.data, "role", None) == "user":
            if message_text(item):
                return item
    return None


def _person_request(item: ConversationItem | None) -> str | None:
    """The person's own words in a user message, or ``None`` for a system-started turn
    (a Result wake) or no message."""
    if item is None or not isinstance(item.data, MessageData) or is_system_notice(item.data):
        return None
    return message_text(item)


def _first_error_message(items: list[ConversationItem]) -> str | None:
    for item in items:
        if item.type == "error":
            return item.data.message  # type: ignore[union-attr]
    return None


def _group_items_by_response(items: list[ConversationItem]) -> list[list[ConversationItem]]:
    """Group a chronological item list into per-turn (``response_id``) runs."""
    groups: dict[str, list[ConversationItem]] = {}
    order: list[str] = []
    for item in items:
        if item.response_id not in groups:
            groups[item.response_id] = []
            order.append(item.response_id)
        groups[item.response_id].append(item)
    return [groups[response_id] for response_id in order]


def _step_detail(
    call: ConversationItem,
    output: ConversationItem | None,
) -> dict[str, Any]:
    detail: dict[str, Any] = {"call": _project_activity_item(call)}
    if output is not None:
        detail["result"] = _project_activity_item(output)
    return detail


def _steps_for_calls(
    calls: list[ConversationItem],
    outputs_by_call_id: dict[str, ConversationItem],
    *,
    include_detail: bool,
    live: bool = False,
) -> list[Step]:
    """Steps for ``calls``; a ``live`` Activity's latest Step carries its call (the
    arguments name what it is doing right now, e.g. the query being searched)."""
    steps: list[Step] = []
    for index, call in enumerate(calls):
        name = call.data.name  # type: ignore[union-attr]
        arguments = call.data.arguments  # type: ignore[union-attr]
        call_id = call.data.call_id  # type: ignore[union-attr]
        steps.append(
            Step(
                item_id=call.id,
                title=step_title_for_call(name, arguments),
                created_at=call.created_at,
                tool=name,
                detail=(
                    _step_detail(call, outputs_by_call_id.get(call_id))
                    if include_detail
                    else {"call": _project_activity_item(call)}
                    if live and index == len(calls) - 1
                    else None
                ),
            )
        )
    return steps


def _turn_status(
    conversation: Conversation,
    group: list[ConversationItem],
    *,
    is_latest_group: bool,
) -> str:
    """Map a turn's items (+ live session status) to an Activity status.

    An ``error`` item in the turn is Failed; an interrupted assistant
    message (the engine's own durable partial-response marker) is
    Cancelled; the latest turn still running/waiting on the live session
    is In Progress; everything else is Done.
    """
    if any(item.type == "error" for item in group):
        return STATUS_FAILED
    if any(item.type == "message" and getattr(item.data, "interrupted", False) for item in group):
        return STATUS_CANCELLED
    if is_latest_group and conversation.live_status in ("running", "waiting"):
        return STATUS_IN_PROGRESS
    if is_latest_group and conversation.live_status == "failed":
        return STATUS_FAILED
    return STATUS_DONE


def _turn_outcome(group: list[ConversationItem], *, status: str) -> str | None:
    if status == STATUS_FAILED:
        return _first_error_message(group) or "Could not complete the request"
    if status == STATUS_CANCELLED:
        return "Cancelled before finishing"
    return _reply_outcome(last_assistant_text(group))


def _reply_outcome(reply: str | None) -> str | None:
    """A reply as the one-line outcome, its acknowledgement opener ("Perfect.") dropped."""
    opened = strip_reply_filler(reply)
    return truncate(opened, _OUTCOME_MAX_CHARS) if opened else None


def _status_summary(
    status: str,
    group: list[ConversationItem],
    outcome: str | None,
    stored_summary: str | None = None,
) -> str | None:
    """The feed row's one-line gist: the model-written result summary, else the answer's
    first sentence; nothing while working."""
    if status == STATUS_IN_PROGRESS:
        return None
    if status == STATUS_DONE:
        return stored_summary or one_line_summary(last_assistant_text(group))
    return outcome


def _turn_title(conversation: Conversation, request: str | None, reply: str | None = None) -> str:
    # Until a model-written title exists, the person's request names the work
    # (tidied); a system-started turn (a Result wake) is named by what it said,
    # then by the chat's title.
    tidied = tidy_request_title(request or _plain_reply(reply))
    if tidied:
        return tidied
    if conversation.title:
        return truncate(conversation.title, _TITLE_MAX_CHARS)
    return "Activity"


def _plain_reply(reply: str | None) -> str | None:
    return None if not reply or STRUCTURED_TEXT.match(reply) else reply


def _turn_title_prompt(request: str, steps: list[Step], result: str | None = None) -> str:
    """What a title is written from: the request, the first few things done for it and,
    once finished, the result to summarise."""
    done = "; ".join(step.title for step in steps[:_TITLE_PROMPT_STEPS])
    prompt = f"Request to name:\n{truncate(request, _TITLE_PROMPT_REQUEST_CHARS)}"
    if done:
        prompt = f"{prompt}\n\nWhat was done for it: {done}"
    if result:
        prompt = f"{prompt}\n\nResult:\n{truncate(result, _TITLE_PROMPT_RESULT_CHARS)}"
    return prompt


def _summarisable_result(reply: str | None) -> str | None:
    """The reply as a Result worth summarising: plain words, not a code block or JSON."""
    return _plain_reply(strip_reply_filler(reply))


def _turn_activity(
    conversation: Conversation,
    group: list[ConversationItem],
    *,
    request: str | None,
    is_latest_group: bool,
    include_step_detail: bool,
    source: str,
    stored_title: str | None,
    stored_summary: str | None = None,
) -> Activity | None:
    """Build the Activity for one turn's items, or ``None`` if it had no tool calls."""
    calls = [item for item in group if item.type == "function_call"]
    if not calls:
        return None
    outputs_by_call_id = {
        item.data.call_id: item  # type: ignore[union-attr]
        for item in group
        if item.type == "function_call_output"
    }
    status = _turn_status(conversation, group, is_latest_group=is_latest_group)
    steps = _steps_for_calls(
        calls,
        outputs_by_call_id,
        include_detail=include_step_detail,
        live=status == STATUS_IN_PROGRESS,
    )
    # A system-started turn has no request of the person's: the reply names the work.
    reply = last_assistant_text(group)
    user_request = request or _plain_reply(reply)
    outcome = _turn_outcome(group, status=status)
    result = _summarisable_result(reply) if status == STATUS_DONE else None
    needs_label = not stored_title or (result is not None and not stored_summary)
    return Activity(
        id=f"{KIND_TURN}:{conversation.id}:{group[0].response_id}",
        kind=KIND_TURN,
        chat_id=conversation.id,
        title=stored_title or _turn_title(conversation, request, reply),
        outcome=outcome,
        status=status,
        started_at=group[0].created_at,
        finished_at=None if status == STATUS_IN_PROGRESS else group[-1].created_at,
        steps=steps,
        source=source,
        summary=_status_summary(status, group, outcome, stored_summary),
        title_prompt=(
            _turn_title_prompt(user_request, steps, result)
            if user_request and needs_label
            else None
        ),
        stored_summary=stored_summary,
    )


def _split_sub_agent_title(conversation: Conversation) -> tuple[str, str]:
    """Best-effort ``(agent, display_title)`` split of a sub-agent's title.

    Named sub-agents (``sys_session_send`` / ``sys_session_close``) persist
    ``"<agent>:<title>"``; ``sys_session_create`` children may carry any
    title. Both are handled leniently (no raise) since an Activity read
    must never fail on an odd title.
    """
    title = title_without_closed_marker(conversation.title)
    if title and ":" in title:
        agent, _, rest = title.partition(":")
        return agent, rest
    return (conversation.sub_agent_name or "sub-agent"), (title or "")


def _sub_agent_source(conversation: Conversation) -> str:
    """Where a Helper came from: a scheduled run (standing task, topic, Goal) or background."""
    if ADHOC_HELPER_LABEL_KEY in conversation.labels:
        return SOURCE_HOUSEKEEPING
    if SCHEDULED_HELPER_LABEL_KEY not in conversation.labels:
        return SOURCE_BACKGROUND
    return SOURCE_GOAL if conversation.sub_agent_name == _GOAL_AGENT_TYPE else SOURCE_SCHEDULED


def _sub_agent_title(
    conversation: Conversation,
    display_title: str,
    task: str | None,
    source: str,
) -> tuple[str, str | None]:
    """``(title, title_prompt)`` for a Helper: its own words about the work, never an id.

    A model-written ``task_summary`` wins; a scheduled Helper shows its task's name
    (never the engine's collision suffix); a spawner-chosen title is kept. Otherwise the
    delegated task is tidied for now and, with ``title_prompt`` set, named by the model.
    """
    if conversation.task_summary:
        return strip_fire_suffix(scrub_internal_words(conversation.task_summary)), None
    if source != SOURCE_BACKGROUND:
        named = scheduled_display_title(display_title)
        if named:
            return named, None
    elif not is_generic_title(display_title):
        return truncate(strip_fire_suffix(display_title), _TITLE_MAX_CHARS), None
    return tidy_request_title(task) or (
        "Working on something" if source == SOURCE_BACKGROUND else "Scheduled work"
    ), (f"Request to name:\n{truncate(task, _TITLE_PROMPT_REQUEST_CHARS)}" if task else None)


def _sub_agent_activity(
    conversation: Conversation,
    items: list[ConversationItem],
    *,
    include_step_detail: bool,
    stored_summary: str | None = None,
) -> Activity:
    _agent, display_title = _split_sub_agent_title(conversation)
    status = sub_agent_status(conversation, items)
    source = _sub_agent_source(conversation)
    title, title_prompt = _sub_agent_title(
        conversation, display_title, _person_request(_first_user_message(items)), source
    )
    calls = [item for item in items if item.type == "function_call"]
    outputs_by_call_id = {
        item.data.call_id: item  # type: ignore[union-attr]
        for item in items
        if item.type == "function_call_output"
    }
    result = _summarisable_result(last_assistant_text(items)) if status == STATUS_DONE else None
    task = _person_request(_first_user_message(items))
    if result and task and (title_prompt is not None or not stored_summary):
        title_prompt = _turn_title_prompt(task, [], result)
    if status == STATUS_FAILED:
        outcome = _first_error_message(items) or (
            "Could not get started"
            if conversation.live_status is None
            else "Could not complete the task"
        )
    elif status == STATUS_CANCELLED:
        outcome = "Cancelled before finishing"
    else:
        outcome = _reply_outcome(last_assistant_text(items))
    started_at = items[0].created_at if items else conversation.created_at
    finished_at = items[-1].created_at if items and status != STATUS_IN_PROGRESS else None
    return Activity(
        id=f"{KIND_SUB_AGENT}:{conversation.id}",
        kind=KIND_SUB_AGENT,
        chat_id=conversation.id,
        title=title,
        outcome=outcome,
        status=status,
        started_at=started_at,
        finished_at=finished_at,
        steps=_steps_for_calls(
            calls,
            outputs_by_call_id,
            include_detail=include_step_detail,
            live=status == STATUS_IN_PROGRESS,
        ),
        source=source,
        summary=_status_summary(status, items, outcome, stored_summary),
        title_prompt=title_prompt,
        stored_summary=stored_summary,
        parent_chat_id=conversation.parent_conversation_id,
    )


# ── Store-backed orchestration ─────────────────────────────────────────


def _activities_for_conversation(
    conv_store: ConversationStore,
    conversation: Conversation,
    *,
    include_step_detail: bool,
    super_chat_id: str,
) -> list[Activity]:
    # Newest-first, bounded, then reversed to chronological order: for a
    # conversation with more than _ITEMS_SCAN_LIMIT items, an ascending scan
    # would return only the OLDEST items and silently miss the current turn
    # — the newest turns and the live/in-progress status must always be
    # covered, so the truncation (if any) falls on the oldest history
    # instead.
    items = list(
        reversed(
            conv_store.list_items(
                conversation.id, limit=_resolve_items_scan_limit(), order="desc"
            ).data
        )
    )
    if conversation.kind == "sub_agent":
        _title, summary = conv_store.get_activity_labels([conversation.id]).get(
            conversation.id, (None, None)
        )
        return [
            _sub_agent_activity(
                conversation,
                items,
                include_step_detail=include_step_detail,
                stored_summary=summary,
            )
        ]
    groups = _group_items_by_response(items)
    stored_labels = conv_store.get_activity_labels([group[0].response_id for group in groups])
    source = SOURCE_TURN if conversation.id == super_chat_id else SOURCE_SIDE_CHAT
    activities: list[Activity] = []
    # The user message that started a turn is usually stored outside its
    # response group, so carry the latest one forward.
    request: str | None = None
    for index, group in enumerate(groups):
        first = _first_user_message(group)
        if first is not None:
            request = _person_request(first)
        activity = _turn_activity(
            conversation,
            group,
            request=request,
            is_latest_group=(index == len(groups) - 1),
            include_step_detail=include_step_detail,
            source=source,
            stored_title=stored_labels.get(group[0].response_id, (None, None))[0],
            stored_summary=stored_labels.get(group[0].response_id, (None, None))[1],
        )
        if activity is not None:
            activities.append(activity)
    return activities


def _zone(tz: str | None) -> tzinfo:
    try:
        return ZoneInfo(tz) if tz else UTC
    except (ZoneInfoNotFoundError, ValueError):
        return UTC


def local_day(epoch_seconds: int, tz: str | None = None) -> str:
    """Calendar day (``YYYY-MM-DD``) of ``epoch_seconds`` in the person's time zone."""
    return datetime.fromtimestamp(epoch_seconds, tz=_zone(tz)).date().isoformat()


def _did_real_work(activity: Activity) -> bool:
    """Whether a conversation turn is worth a row: it did work, not just answered in chat."""
    if len(activity.steps) >= _MIN_TURN_STEPS:
        return True
    # One search, page read, file or browser step is still work the person may want to trace.
    if any(step.tool and is_work_tool(step.tool) for step in activity.steps):
        return True
    end = activity.finished_at if activity.finished_at is not None else activity.started_at
    return end - activity.started_at > _MIN_TURN_SECONDS


def _housekeeping_row(day: str, runs: list[Activity]) -> Activity:
    """One row for a local day's quiet upkeep runs; its Steps are the runs themselves."""
    runs = sorted(runs, key=lambda run: run.started_at)
    live = any(run.status == STATUS_IN_PROGRESS for run in runs)
    count = len(runs)
    return Activity(
        id=f"{KIND_SUB_AGENT}:{HOUSEKEEPING_PREFIX}:{day}",
        kind=KIND_SUB_AGENT,
        chat_id=runs[-1].chat_id,
        title=HOUSEKEEPING_TITLE,
        outcome=None,
        status=STATUS_IN_PROGRESS if live else STATUS_DONE,
        started_at=runs[-1].started_at,
        finished_at=None if live else max(run.finished_at or run.started_at for run in runs),
        steps=[
            Step(
                item_id=run.id,
                title=scrub_internal_words(strip_fire_suffix(run.title)) or "Updated your notes",
                created_at=run.started_at,
            )
            for run in runs
        ],
        source=SOURCE_HOUSEKEEPING,
        summary=f"{count} update{'s' if count != 1 else ''}",
    )


def _feed(activities: list[Activity], tz: str | None) -> list[Activity]:
    """The feed's rows: work not visible in chat, upkeep grouped into one row per local day."""
    rows: list[Activity] = []
    upkeep: dict[str, list[Activity]] = {}
    for activity in activities:
        if activity.source == SOURCE_HOUSEKEEPING:
            upkeep.setdefault(local_day(activity.started_at, tz), []).append(activity)
        elif activity.kind != KIND_TURN or _did_real_work(activity):
            rows.append(activity)
    rows.extend(_housekeeping_row(day, runs) for day, runs in upkeep.items())
    rows.sort(key=lambda activity: activity.started_at, reverse=True)
    return rows


def list_activities(
    conv_store: ConversationStore,
    session_id: str,
    *,
    before: int | None = None,
    limit: int = _DEFAULT_LIMIT,
    tz: str | None = None,
) -> list[Activity]:
    """The user's Activity Feed: every Activity under one Super Chat's family.

    :param conv_store: Store to query.
    :param session_id: The Super Chat (or one of its Side Chats) id.
    :param before: When set, only Activities that started strictly before
        this epoch timestamp.
    :param limit: Maximum Activities to return, newest-first (clamped to
        :data:`_MAX_LIMIT`).
    :param tz: The person's IANA time zone; upkeep runs are grouped by their local day.
    :returns: Activities newest-first; ``[]`` when ``session_id`` doesn't
        resolve to a ``superside-chat`` Super Chat.
    """
    super_chat_id = resolve_super_chat_id(conv_store, session_id)
    if super_chat_id is None:
        return []
    chats = list_chat_family(conv_store, super_chat_id)
    activities: list[Activity] = []
    for conversation in chats:
        activities.extend(
            _activities_for_conversation(
                conv_store, conversation, include_step_detail=False, super_chat_id=super_chat_id
            )
        )
    activities.sort(key=lambda activity: activity.started_at, reverse=True)
    # A Side Chat that knows the conversation carries copies of its items, so the same
    # turn (same response id) is found in both chats; list it once, from the chat that
    # came first in the family (the Super Chat itself).
    seen_turns: set[str] = set()
    unique: list[Activity] = []
    for activity in activities:
        if activity.kind == KIND_TURN:
            response_id = activity.id.rsplit(":", 1)[-1]
            if response_id in seen_turns:
                continue
            seen_turns.add(response_id)
        unique.append(activity)
    activities = _feed(unique, tz)
    if before is not None:
        activities = [activity for activity in activities if activity.started_at < before]
    bounded_limit = max(1, min(limit, _MAX_LIMIT))
    return activities[:bounded_limit]


def activities_missing_titles(activities: list[Activity]) -> list[Activity]:
    """The Activities still showing a fallback title, newest first, bounded per read."""
    return [activity for activity in activities if activity.title_prompt][:_TITLE_JOBS_PER_READ]


def schedule_missing_titles(
    conv_store: ConversationStore,
    coordinator: BackgroundSessionTitleCoordinator,
    activities: list[Activity],
    conversations: Mapping[str, Conversation],
) -> None:
    """Start model-written titles for Activities from :func:`activities_missing_titles`.

    Never waits: the feed answers now with the tidied request, and the title
    appears on a later read once the economy model has written it (a turn's is
    stored by response id, a Helper's as its ``task_summary``). Must run on the
    event loop (the attempts are loop tasks); ``conversations`` is read beforehand.

    :param conv_store: Store the titles are saved to.
    :param coordinator: The app's background title coordinator.
    :param activities: The Activities to title.
    :param conversations: Their chats by id (an Activity with no chat here is skipped).
    """
    for activity in activities:
        conversation = conversations.get(activity.chat_id)
        if conversation is None or activity.title_prompt is None:
            continue
        chat_id = activity.chat_id
        # A result the model gave no summary for keeps the deterministic gist, so a
        # finished row is never summarised twice.
        fallback = activity.summary if activity.status == STATUS_DONE else None
        is_turn = activity.kind == KIND_TURN
        key = label_key = activity.id.rsplit(":", 1)[-1] if is_turn else chat_id

        def save(
            label: str,
            chat_id: str = chat_id,
            label_key: str = label_key,
            fallback: str | None = fallback,
            is_turn: bool = is_turn,
            has_title: bool = bool(conversation.task_summary),
        ) -> object:
            title, summary = split_generated_label(label)
            if not is_turn and not has_title:
                conv_store.set_task_summary(chat_id, title)
            return conv_store.set_activity_title(chat_id, label_key, title, summary or fallback)

        coordinator.schedule_activity_title(
            key=key,
            conversation=conversation,
            prompt=activity.title_prompt,
            instructions=ACTIVITY_TITLE_INSTRUCTIONS,
            clean=clean_generated_label,
            save=save,
        )


def get_activity(
    conv_store: ConversationStore,
    session_id: str,
    activity_id: str,
    tz: str | None = None,
) -> Activity | None:
    """One Activity, in full (steps include capped call/result detail).

    Scoped to ``session_id``'s Super Chat family — an id for an Activity
    outside that family returns ``None``, matching the owner-scoping the
    route layer already enforces on ``session_id`` itself.

    :param conv_store: Store to query.
    :param session_id: The Super Chat (or one of its Side Chats) id.
    :param activity_id: An id previously returned by :func:`list_activities`.
    :returns: The :class:`Activity` with full step detail, or ``None``.
    """
    super_chat_id = resolve_super_chat_id(conv_store, session_id)
    if super_chat_id is None:
        return None
    kind, _, rest = activity_id.partition(":")
    if kind == KIND_SUB_AGENT and rest.startswith(f"{HOUSEKEEPING_PREFIX}:"):
        for row in list_activities(conv_store, session_id, limit=_MAX_LIMIT, tz=tz):
            if row.id == activity_id:
                return row
        return None
    if kind == KIND_SUB_AGENT:
        chat_id = rest
    elif kind == KIND_TURN:
        chat_id, _, _response_id = rest.partition(":")
    else:
        return None
    family = {chat.id: chat for chat in list_chat_family(conv_store, super_chat_id)}
    conversation = family.get(chat_id)
    if conversation is None:
        return None
    for activity in _activities_for_conversation(
        conv_store, conversation, include_step_detail=True, super_chat_id=super_chat_id
    ):
        if activity.id == activity_id:
            return activity
    return None


def iso_date(epoch_seconds: int, tz: str | None = None) -> str:
    """Calendar-day string for grouping Activities by day.

    :param epoch_seconds: Unix epoch timestamp.
    :param tz: The person's IANA time zone (UTC when unset or unknown).
    :returns: ``"YYYY-MM-DD"`` in that zone.
    """
    return local_day(epoch_seconds, tz)


def step_to_dict(step: Step) -> dict[str, Any]:
    """JSON-safe projection of one Step."""
    payload: dict[str, Any] = {
        "item_id": step.item_id,
        "title": step.title,
        "created_at": step.created_at,
    }
    if step.tool is not None:
        payload["tool"] = step.tool
    if step.detail is not None:
        payload["detail"] = step.detail
    return payload


def activity_to_dict(activity: Activity, tz: str | None = None) -> dict[str, Any]:
    """JSON-safe projection of one Activity, for either route."""
    return {
        "id": activity.id,
        "kind": activity.kind,
        "chat_id": activity.chat_id,
        "source": activity.source,
        "title": activity.title,
        "outcome": activity.outcome,
        "summary": activity.summary,
        "status": activity.status,
        "started_at": activity.started_at,
        "finished_at": activity.finished_at,
        "date": iso_date(activity.started_at, tz),
        "steps": [step_to_dict(step) for step in activity.steps],
        "parent_chat_id": activity.parent_chat_id,
    }
