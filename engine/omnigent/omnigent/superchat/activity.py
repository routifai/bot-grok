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
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from omnigent.context.labels import SCHEDULED_HELPER_LABEL_KEY, is_superside_chat
from omnigent.entities import Conversation, ConversationItem
from omnigent.stores.conversation_store import ConversationStore
from omnigent.superchat.activity_titles import (
    ACTIVITY_TITLE_INSTRUCTIONS,
    clean_generated_title,
    is_generic_title,
    plain_text,
    scheduled_display_title,
    tidy_request_title,
)
from omnigent.tools.builtins.spawn import _project_activity_item
from omnigent.util.session_lifecycle import is_session_closed, title_without_closed_marker

if TYPE_CHECKING:
    from omnigent.server.background_session_titles import BackgroundSessionTitleCoordinator

STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"

KIND_TURN = "turn"
KIND_SUB_AGENT = "sub_agent"

#: What an Activity is, for the icon beside it: ``kind`` says how it is stored
#: (and keys its id); ``source`` says where the work came from.
SOURCE_TURN = "turn"
SOURCE_SIDE_CHAT = "side_chat"
SOURCE_BACKGROUND = "background"
SOURCE_SCHEDULED = "scheduled"
SOURCE_GOAL = "goal"
_GOAL_AGENT_TYPE = "goal"

#: Env var overriding the per-chat Activity Feed items-scan limit below.
ITEMS_SCAN_LIMIT_ENV = "OMNIGENT_ACTIVITY_ITEMS_SCAN_LIMIT"

# A feed covering more items than this per chat only sees the newest
# _ITEMS_SCAN_LIMIT (oldest history is what gets truncated, never the
# current turn) — generous enough for ordinary use while keeping one
# page-fetch's cost bounded.
_ITEMS_SCAN_LIMIT = 1000
_SIDE_CHATS_SCAN_LIMIT = 200


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
_SUMMARY_MAX_CHARS = 110
_TITLE_MAX_CHARS = 80
_TITLE_PROMPT_REQUEST_CHARS = 700
_TITLE_PROMPT_STEPS = 6
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
        request tidied (see :mod:`omnigent.superchat.activity_titles`).
    :param outcome: One-line outcome, or ``None`` when nothing to report yet.
    :param summary: A short one-line gist of the outcome for the feed row, or
        ``None`` while in progress (the live Step stands in) or when there is none.
    :param title_prompt: Set only while a model-written title is still missing: the
        text to name the work from. Never serialized.
    :param status: One of :data:`STATUS_IN_PROGRESS`, :data:`STATUS_DONE`,
        :data:`STATUS_FAILED`, :data:`STATUS_CANCELLED`.
    :param started_at: Unix epoch timestamp of the first item.
    :param finished_at: Unix epoch timestamp of the last item, or ``None``
        while still in progress.
    :param steps: The Activity's Steps, chronological.
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


def _truncate(text: str, limit: int) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: max(0, limit - 1)].rstrip() + "…"


#: A reply that is a code block or raw JSON (a Helper's machine-readable Result) says
#: nothing in a one-line gist.
_STRUCTURED_TEXT = re.compile(r"\s*(?:```|[{\[])")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s")


def _one_line_summary(text: str | None) -> str | None:
    """The first sentence of ``text`` as plain words, at most :data:`_SUMMARY_MAX_CHARS`."""
    if not text or _STRUCTURED_TEXT.match(text):
        return None
    plain = plain_text(text)
    if not plain:
        return None
    first = _SENTENCE_END.split(plain, maxsplit=1)[0]
    if len(first) < 10:
        first = plain
    return _truncate(first, _SUMMARY_MAX_CHARS)


def _message_text(item: ConversationItem) -> str | None:
    projected = _project_activity_item(item, max_chars=_OUTCOME_MAX_CHARS * 4)
    text = projected.get("content")
    return text or None


def _first_user_text(items: list[ConversationItem]) -> str | None:
    for item in items:
        if item.type == "message" and getattr(item.data, "role", None) == "user":
            text = _message_text(item)
            if text:
                return text
    return None


def _last_assistant_text(items: list[ConversationItem]) -> str | None:
    for item in reversed(items):
        if item.type == "message" and getattr(item.data, "role", None) == "assistant":
            text = _message_text(item)
            if text:
                return text
    return None


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
    last_assistant = _last_assistant_text(group)
    return _truncate(last_assistant, _OUTCOME_MAX_CHARS) if last_assistant else None


def _user_request(request: str | None) -> str | None:
    """The person's own request, or ``None`` for a system-started turn (a Result wake)."""
    return None if not request or request.startswith("[System") else request


def _status_summary(status: str, group: list[ConversationItem], outcome: str | None) -> str | None:
    """The feed row's one-line gist: the answer's first sentence; nothing while working."""
    if status == STATUS_IN_PROGRESS:
        return None
    if status == STATUS_DONE:
        return _one_line_summary(_last_assistant_text(group))
    return outcome


def _turn_title(conversation: Conversation, request: str | None, reply: str | None = None) -> str:
    # Until a model-written title exists, the person's request names the work
    # (tidied); a system-started turn (a Result wake) is named by what it said,
    # then by the chat's title.
    tidied = tidy_request_title(_user_request(request) or _plain_reply(reply))
    if tidied:
        return tidied
    if conversation.title:
        return _truncate(conversation.title, _TITLE_MAX_CHARS)
    return "Activity"


def _plain_reply(reply: str | None) -> str | None:
    return None if not reply or _STRUCTURED_TEXT.match(reply) else reply


def _turn_title_prompt(request: str, steps: list[Step]) -> str:
    """What a title is written from: the request and the first few things done for it."""
    done = "; ".join(step.title for step in steps[:_TITLE_PROMPT_STEPS])
    prompt = f"Request to name:\n{_truncate(request, _TITLE_PROMPT_REQUEST_CHARS)}"
    return f"{prompt}\n\nWhat was done for it: {done}" if done else prompt


def _turn_activity(
    conversation: Conversation,
    group: list[ConversationItem],
    *,
    request: str | None,
    is_latest_group: bool,
    include_step_detail: bool,
    source: str,
    stored_title: str | None,
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
    reply = _last_assistant_text(group)
    user_request = _user_request(request) or _plain_reply(reply)
    outcome = _turn_outcome(group, status=status)
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
        summary=_status_summary(status, group, outcome),
        title_prompt=(
            _turn_title_prompt(user_request, steps) if user_request and not stored_title else None
        ),
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
        return conversation.task_summary, None
    if source != SOURCE_BACKGROUND:
        named = scheduled_display_title(display_title)
        if named:
            return named, None
    elif not is_generic_title(display_title):
        return _truncate(display_title, _TITLE_MAX_CHARS), None
    request = _user_request(task)
    return tidy_request_title(request) or (
        "Background task" if source == SOURCE_BACKGROUND else "Scheduled task"
    ), (
        f"Request to name:\n{_truncate(request, _TITLE_PROMPT_REQUEST_CHARS)}" if request else None
    )


def _sub_agent_status(conversation: Conversation) -> str:
    """Map a sub-agent conversation's live status (+ close marker) to an Activity status.

    ``live_status`` is authoritative when the runtime has reported one.
    Flagged ambiguity: the store has no distinct "cancelled" marker
    separate from a normal close, so a sub-agent tombstoned before ever
    reporting a turn (``live_status`` still unset) reads as Cancelled;
    one tombstoned after finishing at least one turn reads as Done.
    """
    if conversation.live_status == "failed":
        return STATUS_FAILED
    if conversation.live_status in ("running", "waiting"):
        return STATUS_IN_PROGRESS
    if conversation.live_status is None and is_session_closed(
        conversation.labels, conversation.title
    ):
        return STATUS_CANCELLED
    return STATUS_DONE


def _sub_agent_activity(
    conversation: Conversation,
    items: list[ConversationItem],
    *,
    include_step_detail: bool,
) -> Activity:
    _agent, display_title = _split_sub_agent_title(conversation)
    status = _sub_agent_status(conversation)
    source = _sub_agent_source(conversation)
    title, title_prompt = _sub_agent_title(
        conversation, display_title, _first_user_text(items), source
    )
    calls = [item for item in items if item.type == "function_call"]
    outputs_by_call_id = {
        item.data.call_id: item  # type: ignore[union-attr]
        for item in items
        if item.type == "function_call_output"
    }
    if status == STATUS_FAILED:
        outcome = _first_error_message(items) or "Could not complete the task"
    elif status == STATUS_CANCELLED:
        outcome = "Cancelled before finishing"
    else:
        last_assistant = _last_assistant_text(items)
        outcome = _truncate(last_assistant, _OUTCOME_MAX_CHARS) if last_assistant else None
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
        summary=_status_summary(status, items, outcome),
        title_prompt=title_prompt,
    )


# ── Store-backed orchestration ─────────────────────────────────────────


def resolve_super_chat_id(conv_store: ConversationStore, session_id: str) -> str | None:
    """Resolve ``session_id`` to its Super Chat id.

    A Super Chat resolves to itself; a Side Chat resolves to the Super
    Chat it was forked from (one level only — Side Chats never fork from
    another Side Chat, per ``rollover/CONTEXT.md``).

    :param conv_store: Store to query.
    :param session_id: A Super Chat or Side Chat conversation id.
    :returns: The Super Chat's conversation id, or ``None`` if
        ``session_id`` does not exist.
    """
    conversation = conv_store.get_conversation(session_id)
    # Sub-agent ids never carry FORK_SOURCE_LABEL_KEY, so without this guard
    # one would otherwise resolve to itself as a (wrong) "Super Chat".
    if conversation is None or conversation.kind == "sub_agent":
        return None
    from omnigent.stores.conversation_store import FORK_SOURCE_LABEL_KEY

    source_id = conversation.labels.get(FORK_SOURCE_LABEL_KEY)
    return source_id or session_id


def list_chat_family(conv_store: ConversationStore, super_chat_id: str) -> list[Conversation]:
    """The Super Chat, its Side Chats, and every Sub-agent descendant of either.

    Returns ``[]`` when ``super_chat_id`` does not exist or is not a
    ``superside-chat`` session — the Activity Feed only ever covers that
    mode (``rollover/SUPERSIDE-CHAT-PLAN.md`` S5).

    :param conv_store: Store to query.
    :param super_chat_id: The Super Chat's conversation id.
    :returns: ``[super_chat, *side_chats, *sub_agents]``, each a full
        :class:`Conversation`.
    """
    from omnigent.context.rollover import list_related_chats

    root = conv_store.get_conversation(super_chat_id)
    if root is None or not is_superside_chat(root.labels):
        return []
    chats = [root]
    side_chat_ids = [
        chat["id"]
        for chat in list_related_chats(conv_store, super_chat_id, limit=_SIDE_CHATS_SCAN_LIMIT)
    ]
    if side_chat_ids:
        side_chats_by_id = conv_store.get_conversations(side_chat_ids)
        chats.extend(
            conv
            for conv_id in side_chat_ids
            if (conv := side_chats_by_id.get(conv_id)) is not None
            and is_superside_chat(conv.labels)
        )

    sub_agents: list[Conversation] = []
    frontier = [chat.id for chat in chats]
    seen = set(frontier)
    while frontier:
        child_map = conv_store.list_child_conversation_ids_by_parent(frontier)
        next_frontier = [
            child_id
            for parent_id in frontier
            for child_id in child_map.get(parent_id, [])
            if child_id not in seen
        ]
        seen.update(next_frontier)
        if next_frontier:
            fetched = conv_store.get_conversations(next_frontier)
            sub_agents.extend(
                fetched[child_id] for child_id in next_frontier if child_id in fetched
            )
        frontier = next_frontier
    return chats + sub_agents


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
        return [_sub_agent_activity(conversation, items, include_step_detail=include_step_detail)]
    groups = _group_items_by_response(items)
    stored_titles = conv_store.get_activity_titles([group[0].response_id for group in groups])
    source = SOURCE_TURN if conversation.id == super_chat_id else SOURCE_SIDE_CHAT
    activities: list[Activity] = []
    # The user message that started a turn is usually stored outside its
    # response group, so carry the latest one forward.
    request: str | None = None
    for index, group in enumerate(groups):
        request = _first_user_text(group) or request
        activity = _turn_activity(
            conversation,
            group,
            request=request,
            is_latest_group=(index == len(groups) - 1),
            include_step_detail=include_step_detail,
            source=source,
            stored_title=stored_titles.get(group[0].response_id),
        )
        if activity is not None:
            activities.append(activity)
    return activities


def list_activities(
    conv_store: ConversationStore,
    session_id: str,
    *,
    before: int | None = None,
    limit: int = _DEFAULT_LIMIT,
) -> list[Activity]:
    """The user's Activity Feed: every Activity under one Super Chat's family.

    :param conv_store: Store to query.
    :param session_id: The Super Chat (or one of its Side Chats) id.
    :param before: When set, only Activities that started strictly before
        this epoch timestamp.
    :param limit: Maximum Activities to return, newest-first (clamped to
        :data:`_MAX_LIMIT`).
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
    activities = unique
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
        if activity.kind == KIND_TURN:
            key = response_id = activity.id.rsplit(":", 1)[-1]

            def save(title: str, chat_id: str = chat_id, response_id: str = response_id) -> object:
                return conv_store.set_activity_title(chat_id, response_id, title)

        else:
            key = chat_id

            def save(title: str, chat_id: str = chat_id) -> object:
                return conv_store.set_task_summary(chat_id, title)

        coordinator.schedule_activity_title(
            key=key,
            conversation=conversation,
            prompt=activity.title_prompt,
            instructions=ACTIVITY_TITLE_INSTRUCTIONS,
            clean=clean_generated_title,
            save=save,
        )


def get_activity(
    conv_store: ConversationStore,
    session_id: str,
    activity_id: str,
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


def iso_date(epoch_seconds: int) -> str:
    """UTC calendar-day string for grouping Activities by day.

    :param epoch_seconds: Unix epoch timestamp.
    :returns: ``"YYYY-MM-DD"`` in UTC.
    """
    return datetime.fromtimestamp(epoch_seconds, tz=UTC).date().isoformat()


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


def activity_to_dict(activity: Activity) -> dict[str, Any]:
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
        "date": iso_date(activity.started_at),
        "steps": [step_to_dict(step) for step in activity.steps],
    }
