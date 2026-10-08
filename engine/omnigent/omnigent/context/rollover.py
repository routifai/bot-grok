"""Rollover: thresholds, the checkpoint header and summarizer instruction,
and the Omnigent-written checkpoint used to seed side chats.

In a rollover session each native CLI compacts its own context at
:func:`resolve_rollover_threshold` (see ``rollover/README.md``).
:func:`build_side_chat_seed` is the one place Omnigent writes a checkpoint
itself: a side chat starts from the parent's summary plus recent turns.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from omnigent.context.labels import (
    ADHOC_HELPER_LABEL_KEY,
    DEFAULT_KEEP_TOKENS,
    ROLLOVER_AT_TOKENS_LABEL,
    ROLLOVER_KEEP_TOKENS_LABEL,
    SCHEDULED_HELPER_LABEL_KEY,
    is_rollover,
)
from omnigent.entities import (
    NON_CONTENT_ITEM_TYPES,
    CompactionData,
    Conversation,
    ConversationItem,
    MessageData,
)
from omnigent.runtime.compaction import count_tokens, summarize_history
from omnigent.server.auth import local_single_user_enabled
from omnigent.server.routes._sessions.common import (
    _LAST_CONTEXT_TOKENS_LABEL_KEY,
    _LAST_CONTEXT_WINDOW_LABEL_KEY,
)
from omnigent.stores.conversation_store import (
    SIDE_CHAT_LABEL_KEY,
    SIDE_CHAT_START_LABEL_KEY,
    ConversationStore,
    side_chat_parent_id,
)
from omnigent.superchat.side_chats.chats import SIDE_CHAT_START_WITH_CONTEXT

# A turn in flight, read from the durable ``Conversation.live_status`` (no runner probe).
_MID_TURN_LIVE_STATUSES = ("running", "waiting")

# Fallback threshold when no window is known for the session's model —
# well under the smallest context window Omnigent routes to today.
DEFAULT_ROLLOVER_THRESHOLD_TOKENS = 100_000

# Claude Code starts at ~60k tokens and Codex keeps ~20k of user messages, so
# a lower threshold leaves the CLI over it right after compacting: a loop.
MIN_ROLLOVER_THRESHOLD_TOKENS = 100_000
_MIN_THRESHOLD_WINDOW_FRACTION = 0.8

# Fraction of the session's context window used as the default threshold,
# leaving headroom for a heavy tool turn before the CLI hits its own limit.
_DEFAULT_THRESHOLD_WINDOW_FRACTION = 0.6

# Ceiling on the *default* (window-derived) threshold only — an explicit
# ROLLOVER_AT_TOKENS_LABEL is never capped. Keeps a huge-window model (e.g.
# claude-sonnet-5's 1M) from deferring compaction so long the summary itself
# gets unwieldy.
MAX_DEFAULT_ROLLOVER_THRESHOLD_TOKENS = 200_000

# Marks the synthetic request/summary exchange prepended to a rollover's
# ``compacted_messages`` (and detected by build_summarization_prompt's
# progressive-summarization check) so the rolling summary stays cumulative.
_SUMMARY_REQUEST_TEXT = (
    "[This is an automatically generated summary of the prior conversation "
    "context. The original messages are available but not included in this "
    "prompt for brevity.]\n\nPlease provide a summary of our conversation so far."
)

# Fixed, code-authored preface for every rollover summary: never written by
# the LLM, so its wording can't drift.
CHECKPOINT_MARKER = "[Context checkpoint inserted by the system, not a message from the user.]"
CHECKPOINT_HEADER = (
    f"{CHECKPOINT_MARKER} "
    "This conversation grew past its context limit and earlier turns were "
    "compacted into the summary below. The work in it is your own; build on "
    "it instead of redoing it. Files, processes and jobs your tools created "
    "still exist. Standing instructions and memory are live every turn and "
    "are not part of this summary. When facts conflict, the latest evidence "
    "and user corrections win. The summary may omit details: recover exact "
    "earlier messages with the session_history tool before relying on them."
)

# A side chat's seed reuses the checkpoint summary but not its framing: the
# model must know it is a separate chat, not the conversation that rolled over.
# It keeps the marker so every seed is recognised by :func:`is_checkpoint_text`.
SIDE_CHAT_SEED_HEADER = (
    f"{CHECKPOINT_MARKER} "
    "[Side chat opened from the person's main Conversation. Below is a summary "
    "of that Conversation and its recent turns, for context. This side chat is "
    "separate: it does not send anything back to the main Conversation.]"
)


# A reset (``POST /sessions/{id}/reset``) is a checkpoint with no summary: the person cleared
# the conversation. Stored as a ``compaction`` item whose ``response_id`` starts with
# RESET_RESPONSE_PREFIX; the marker keeps it a checkpoint for :func:`is_checkpoint_text`.
RESET_RESPONSE_PREFIX = "reset_"
RESET_HEADER = (
    f"{CHECKPOINT_MARKER} "
    "The person cleared this conversation. Earlier turns are not part of your context: start "
    "fresh and do not bring them up unless the person asks. Memory, standing instructions, "
    "files, side chats and goals are unchanged."
)
RESET_ACK = "Understood. Starting fresh."


def is_reset_item(item: Mapping[str, Any]) -> bool:
    """:returns: Whether a flat item dict is a reset checkpoint."""
    response_id = item.get("response_id")
    return (
        item.get("type") == "compaction"
        and isinstance(response_id, str)
        and response_id.startswith(RESET_RESPONSE_PREFIX)
    )


def build_reset_item(last_item_id: str, *, model: str | None) -> CompactionData:
    """The checkpoint a reset stores: no summary, only the reset framing."""
    messages = _summary_exchange(RESET_ACK, RESET_HEADER)
    return CompactionData(
        summary=RESET_HEADER,
        last_item_id=last_item_id,
        model=model,
        token_count=len(RESET_HEADER + RESET_ACK) // 4,
        compacted_messages=messages,
    )


def is_checkpoint_text(text: str) -> bool:
    """:returns: Whether *text* opens a rollover or side-chat seed checkpoint."""
    return text.startswith(CHECKPOINT_MARKER)


# Seeds stored before the side-chat header carried the marker start with it bare.
_SEED_HEADERS = (
    RESET_HEADER,
    SIDE_CHAT_SEED_HEADER,
    SIDE_CHAT_SEED_HEADER.removeprefix(f"{CHECKPOINT_MARKER} "),
    CHECKPOINT_HEADER,
)
# A heading that opens a section listing tools or capabilities: the person never reads it.
_TOOLS_SECTION_TITLE = re.compile(r"\b(technical|tools?|capabilit)", re.IGNORECASE)
_HEADING = re.compile(r"^#{1,6}\s+(.*)$")


def _strip_seed_header(summary: str) -> str:
    """:returns: *summary* without its model-facing seed or checkpoint header."""
    for header in _SEED_HEADERS:
        if summary.startswith(header):
            return summary.removeprefix(header).lstrip()
    return summary


def person_facing_summary(summary: str | None) -> str | None:
    """
    A seed summary as the person should read it.

    Drops the model-facing framing header, a "Context checkpoint" title and any section
    whose heading lists tools or capabilities; the rest stays markdown.

    :param summary: A stored checkpoint or seed summary, or ``None``.
    :returns: The readable body, or ``None`` when *summary* is empty or nothing remains.
    """
    if not summary:
        return None
    kept: list[str] = []
    skipping = False
    for line in _strip_seed_header(summary).splitlines():
        heading = _HEADING.match(line.strip())
        if heading:
            title = heading.group(1)
            if title.lower().startswith("context checkpoint"):
                continue
            skipping = bool(_TOOLS_SECTION_TITLE.search(title))
        if not skipping:
            kept.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip() or None


# Placeholder substituted by the pi-native resident bridge, which can't know
# the real compaction date at session-launch time (the summary may be built
# hours or days later, inside Pi's own session_before_compact hook).
SUMMARIZER_DATE_PLACEHOLDER = "{today}"


def state_file_summarizer_instruction(*, today: str | None = None) -> str:
    """Build the "state file, not a narrative" summarizer instruction
    with today's date filled in by code.

    :param today: ISO date to embed, or ``None`` to use UTC today (the
        server-side rollover path, where the summary is built right away).
        Pass :data:`SUMMARIZER_DATE_PLACEHOLDER` for a caller that fills the
        date in itself at the actual moment of summarization.
    """
    # Date plus time and zone: a bare UTC date reads as "tomorrow" to a model whose own
    # clock is local, and the summary then treats "today only" facts as expired.
    resolved_today = today if today is not None else f"{datetime.now(UTC):%Y-%m-%d %H:%M} UTC"
    return (
        f"Write the summary as a state file, not a narrative. Start with "
        f"'## Context checkpoint — {resolved_today}'. Organize by topic: the user's "
        "identity, preferences and constraints (including corrections and "
        '"do not" rules) first; each active task with its exact identifiers '
        "(ids, paths, URLs, numbers), a time-zoned timestamp, its status, "
        "and its next step; keep look-alike items in separate sections; "
        'state negative facts explicitly (e.g. "no message was sent"); '
        "record what the user was told about any failure; use only "
        "absolute dates, never relative ones. End with 'Current position / "
        "next step'. If the input already starts with a prior checkpoint, "
        "rewrite it into the new one — update entries in place and drop "
        "resolved noise — rather than appending to it. Tool errors (HTTP "
        "404s, 'not configured', timeouts) are transient plumbing, not facts "
        "about the user or the conversation: never record them as the reason "
        "earlier messages are missing, and never claim earlier messages are "
        "inaccessible — the full record is always recoverable with "
        "session_history. Never list tool names, function names or other "
        "internal system names (no 'technical capabilities' sections): the "
        "person may read this summary."
    )


def _parse_positive_int(raw: str | None) -> int | None:
    """Parse *raw* as a positive int, or ``None`` when unset/invalid."""
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def reported_context_tokens(labels: Mapping[str, str] | None) -> int | None:
    """The context size a native forwarder last reported, if any."""
    return _parse_positive_int((labels or {}).get(_LAST_CONTEXT_TOKENS_LABEL_KEY))


def reported_context_window(labels: Mapping[str, str] | None) -> int | None:
    """The context window a native forwarder last reported, if any."""
    return _parse_positive_int((labels or {}).get(_LAST_CONTEXT_WINDOW_LABEL_KEY))


def resolve_rollover_threshold(
    labels: Mapping[str, str] | None, *, model_window: int | None = None
) -> int:
    """
    Resolve the token count at which a rollover session rolls over.

    Priority: the :data:`~omnigent.context.labels.ROLLOVER_AT_TOKENS_LABEL`
    label (an explicit positive int) > 60% of the session's context window
    (the last-reported window label, else *model_window*) >
    :data:`DEFAULT_ROLLOVER_THRESHOLD_TOKENS`. The window-derived default is
    capped at :data:`MAX_DEFAULT_ROLLOVER_THRESHOLD_TOKENS`; an explicit label
    is not. Never below :data:`MIN_ROLLOVER_THRESHOLD_TOKENS` (that floor
    itself capped at 80% of a known window).

    :param labels: The session's labels, or ``None``.
    :param model_window: The session's model's context window, used when no
        :data:`~omnigent.server.routes._sessions.common._LAST_CONTEXT_WINDOW_LABEL_KEY`
        label has been reported yet (e.g. at native launch, before the CLI's
        first turn). Ignored once that label is present.
    :returns: The threshold, in tokens.
    """
    labels = labels or {}
    window = _parse_positive_int(labels.get(_LAST_CONTEXT_WINDOW_LABEL_KEY))
    if window is None:
        window = model_window if model_window and model_window > 0 else None
    threshold = _parse_positive_int(labels.get(ROLLOVER_AT_TOKENS_LABEL))
    if threshold is None:
        threshold = (
            min(
                int(window * _DEFAULT_THRESHOLD_WINDOW_FRACTION),
                MAX_DEFAULT_ROLLOVER_THRESHOLD_TOKENS,
            )
            if window is not None
            else DEFAULT_ROLLOVER_THRESHOLD_TOKENS
        )
    floor = MIN_ROLLOVER_THRESHOLD_TOKENS
    if window is not None:
        floor = min(floor, int(window * _MIN_THRESHOLD_WINDOW_FRACTION))
    return max(threshold, floor)


def split_at_latest_compaction(
    items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Split a chronological record into ``(items_after_checkpoint, latest_compaction)``.

    The checkpoint covers the record up to its ``last_item_id`` (the anchor
    captured when the rollover STARTED), not up to its own position: a turn
    that ran while the summarizer was working lands in the record before the
    compaction item but after the anchor, and must stay in the context.
    So the result is the items after the anchor (when it precedes the
    compaction item) minus the compaction item itself, plus everything after
    the compaction item. An absent or unknown anchor (e.g. a native
    forwarder's synthetic boundary id) falls back to "everything after the
    compaction item". ``(items, None)`` when there is no compaction.
    """
    idx = next(
        (i for i in range(len(items) - 1, -1, -1) if items[i].get("type") == "compaction"),
        None,
    )
    if idx is None:
        return items, None
    compaction = items[idx]
    anchor_id = compaction.get("last_item_id")
    anchor_idx = next(
        (i for i in range(idx) if anchor_id and items[i].get("id") == anchor_id), None
    )
    during = (
        [it for it in items[anchor_idx + 1 : idx] if it.get("type") != "compaction"]
        if anchor_idx is not None
        else []
    )
    return during + items[idx + 1 :], compaction


def resolve_keep_tokens(labels: Mapping[str, str] | None) -> int:
    """Resolve ``omnigent.context.rollover_keep_tokens``, default 16,000."""
    labels = labels or {}
    value = _parse_positive_int(labels.get(ROLLOVER_KEEP_TOKENS_LABEL))
    return value if value is not None else DEFAULT_KEEP_TOKENS


# A kept turn's tool output above this is cut, so one huge result can't keep the
# relaunched context over the threshold and trigger a rollover every turn.
_KEPT_OUTPUT_MAX_CHARS = 8_000
_TRUNCATED_OUTPUT_NOTE = "\n[output truncated at rollover; the full result is in session_history]"


def _cap_tool_outputs(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Truncate oversized ``function_call_output`` text in a kept tail."""
    capped: list[dict[str, Any]] = []
    for item in items:
        output = item.get("output")
        if (
            item.get("type") == "function_call_output"
            and isinstance(output, str)
            and len(output) > _KEPT_OUTPUT_MAX_CHARS
        ):
            item = {**item, "output": output[:_KEPT_OUTPUT_MAX_CHARS] + _TRUNCATED_OUTPUT_NOTE}
        capped.append(item)
    return capped


def select_recent(
    items: list[dict[str, Any]],
    *,
    keep_tokens: int,
    model: str,
) -> list[dict[str, Any]]:
    """
    Select the trailing whole turns to keep verbatim.

    A turn is a user message plus everything after it up to (not including)
    the next user message; turns are never split, so a kept ``function_call``
    keeps its output. The most recent turn is always kept (rollover runs right
    after it finishes); earlier turns are added while the whole tail, last turn
    included, stays within *keep_tokens*.

    :param items: Chronological (oldest first) flat item dicts.
    :param keep_tokens: Token budget for the whole tail, last turn included.
    :param model: LLM model string, used to pick a tokenizer for the budget.
    :returns: The selected trailing whole turns, chronological, or ``[]`` when
        *items* has no user message.
    """
    turn_starts = [
        i
        for i, item in enumerate(items)
        if item.get("type") == "message" and item.get("role") == "user"
    ]
    if not turn_starts:
        return []
    selected_start = turn_starts[-1]
    for start in reversed(turn_starts[:-1]):
        if count_tokens(items[start:], model) > keep_tokens:
            break
        selected_start = start
    return items[selected_start:]


# The Responses API input fields per item type. Anything else a harness adds
# (ids, stream ids, statuses) makes a strict provider reject the call.
_SUMMARIZER_INPUT_FIELDS: dict[str, tuple[str, ...]] = {
    "message": ("type", "role", "content"),
    "function_call": ("type", "call_id", "name", "arguments"),
    "function_call_output": ("type", "call_id", "output"),
}
_TEXT_BLOCK_TYPES = frozenset({"input_text", "output_text"})


def _content_for_summarizer(content: Any) -> Any:
    """Keep text blocks as bare ``{type, text}``; other blocks pass through."""
    if not isinstance(content, list):
        return content
    return [
        {"type": block["type"], "text": block.get("text", "")}
        if isinstance(block, dict) and block.get("type") in _TEXT_BLOCK_TYPES
        else block
        for block in content
    ]


def _items_for_summarizer(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project *items* onto the provider input schema for the summary call.

    Only messages and tool calls/results are sent, with only their schema
    fields; reasoning and harness-specific items are dropped. The kept tail
    (:func:`select_recent`) keeps the full dicts the resume rebuilders need.
    """
    projected: list[dict[str, Any]] = []
    for item in items:
        fields = _SUMMARIZER_INPUT_FIELDS.get(str(item.get("type")))
        if fields is None:
            continue
        out = {key: item[key] for key in fields if key in item}
        if "content" in out:
            out["content"] = _content_for_summarizer(out["content"])
        projected.append(out)
    return projected


_TRANSCRIPT_OUTPUT_LIMIT = 2_000


def _block_text(content: Any) -> str:
    """Join the text blocks of a message's content."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(block.get("text", "")) for block in content if isinstance(block, dict)
    ).strip()


def _transcript_message(
    items: list[dict[str, Any]], previous_summary: str | None
) -> dict[str, Any]:
    """Render the window as one transcript message for the summarizer.

    Sent as live chat turns, a weak model continues the conversation instead
    of summarizing it; as quoted text it can only be summarized.
    """
    lines: list[str] = []
    if previous_summary:
        # Stored summaries carry the header; feed back only the summary itself.
        lines += [_SUMMARY_REQUEST_TEXT, "", _strip_seed_header(previous_summary), ""]
    lines.append("<conversation>")
    for item in items:
        kind = item.get("type")
        if kind == "message":
            role = str(item.get("role", "user")).upper()
            lines.append(f"{role}: {_block_text(item.get('content'))}")
        elif kind == "function_call":
            lines.append(f"TOOL CALL {item.get('name')}: {item.get('arguments', '')}")
        elif kind == "function_call_output":
            output = str(item.get("output", ""))[:_TRANSCRIPT_OUTPUT_LIMIT]
            lines.append(f"TOOL RESULT: {output}")
    lines += [
        "</conversation>",
        "",
        "Write the context checkpoint for the conversation above now.",
    ]
    return {
        "type": "message",
        "role": "user",
        "content": [{"type": "input_text", "text": "\n".join(lines)}],
    }


def _summary_exchange(
    summary_text: str, request_text: str = _SUMMARY_REQUEST_TEXT
) -> list[dict[str, Any]]:
    """Build the synthetic user/assistant pair standing in for a summary."""
    return [
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": request_text}],
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": summary_text}],
        },
    ]


async def build_rollover_item(
    items_since_previous_compaction: list[dict[str, Any]],
    *,
    previous_summary: str | None,
    keep_tokens: int = DEFAULT_KEEP_TOKENS,
    model: str,
    llm_client: Any = None,
    connection: dict[str, str] | None = None,
    runner_client: Any | None = None,
    conversation_id: str | None = None,
) -> CompactionData:
    """
    Build the next rollover compaction item: a rolling summary + recent tail.

    The summary covers everything in *items_since_previous_compaction*,
    merged with *previous_summary* (progressive summarization — see
    ``summarize_history``/``build_summarization_prompt``) so it stays
    cumulative across rollovers rather than restarting each time. The LLM's
    own text is asked for as a state file (``state_file_summarizer_instruction``)
    and then given the fixed, code-authored :data:`CHECKPOINT_HEADER` — never
    written by the LLM itself. ``compacted_messages`` is shaped exactly like
    other producers' (``compaction_to_history_items``, the codex forwarder's
    ``replacement_history``): flat item dicts, summary pair first, so both
    the claude-native and codex-native resume rebuilders accept it directly.
    No memory/standing-instruction content goes in here — those are injected
    live every turn (see the header) — and ``token_count`` is the estimated
    size of summary + kept tail together (Claude's ``compact_boundary``
    needs a real post-compaction figure, not just the summary's own size).

    :param items_since_previous_compaction: This session's items after the
        latest compaction item (or the whole record when there is none),
        chronological, as flat item dicts. Must be non-empty.
    :param previous_summary: The prior rollover's summary text, or ``None``
        for the session's first rollover.
    :param keep_tokens: Token budget for the kept tail.
    :param model: LLM model string for the summarization call and its
        token estimate.
    :param llm_client: LLM client for direct summarization. Ignored when
        *runner_client* is set.
    :param connection: Per-provider connection overrides, forwarded as-is.
    :param runner_client: When set, delegates the summarization LLM call to
        the runner's ``/v1/summarize`` so the runner's own credentials are
        used (the preferred path — see ``summarize_history``).
    :param conversation_id: Session id, forwarded to the runner delegation.
    :returns: A new :class:`CompactionData` ready to be posted as a
        ``compaction`` item.
    :raises ValueError: If *items_since_previous_compaction* is empty.
    """
    if not items_since_previous_compaction:
        raise ValueError("build_rollover_item requires at least one item to summarize")

    messages_to_summarize = [
        _transcript_message(
            _items_for_summarizer(items_since_previous_compaction), previous_summary
        )
    ]

    summary = await summarize_history(
        messages_to_summarize,
        llm_client,
        model,
        connection,
        runner_client,
        conversation_id,
        extra_instructions=state_file_summarizer_instruction(),
    )
    if not isinstance(summary.get("text"), str) or not summary["text"].strip():
        # Never persist an empty checkpoint: the caller keeps the previous one
        # and retries on a later turn.
        raise ValueError("rollover summarizer returned no summary text")
    summary_text = f"{CHECKPOINT_HEADER}\n\n{summary['text']}"
    recent = _cap_tool_outputs(
        select_recent(items_since_previous_compaction, keep_tokens=keep_tokens, model=model)
    )
    last_item_id = items_since_previous_compaction[-1]["id"]
    # The relaunched CLI sees the header where the summarizer saw its request.
    compacted_messages = _summary_exchange(summary["text"], CHECKPOINT_HEADER) + recent
    return CompactionData(
        summary=summary_text,
        last_item_id=last_item_id,
        model=model,
        token_count=count_tokens(compacted_messages, model),
        compacted_messages=compacted_messages,
    )


def _side_chat_framed(seed: CompactionData) -> CompactionData:
    """Swap the rollover checkpoint header for the side chat's own framing."""

    def swap(text: str) -> str:
        if text.startswith(CHECKPOINT_HEADER):
            return SIDE_CHAT_SEED_HEADER + text.removeprefix(CHECKPOINT_HEADER)
        return text

    messages = seed.compacted_messages
    if messages:
        messages = [dict(m) for m in messages]
        first = messages[0]
        content = first.get("content")
        if first.get("role") == "user" and isinstance(content, list):
            first["content"] = [
                {**b, "text": swap(b["text"])}
                if isinstance(b, dict) and isinstance(b.get("text"), str)
                else b
                for b in content
            ]
    return seed.model_copy(
        update={"summary": swap(seed.summary or ""), "compacted_messages": messages}
    )


async def _side_chat_checkpoint(
    items: list[dict[str, Any]],
    *,
    keep_tokens: int = DEFAULT_KEEP_TOKENS,
    model: str,
    llm_client: Any = None,
    connection: dict[str, str] | None = None,
    runner_client: Any | None = None,
    conversation_id: str | None = None,
) -> CompactionData:
    """
    Build the seed compaction item for a rollover side chat, Muse-style.

    A side chat forked from a rollover session stays a rollover session,
    but must not inherit the parent's full transcript — its CLI opens from
    exactly one checkpoint: the parent's latest summary (built now, over the
    whole record, if the parent never rolled over) plus the recent tail.

    :param items: The parent's full chronological record, as flat item
        dicts. Must be non-empty.
    :param keep_tokens: Token budget for the kept tail.
    :param model: LLM model string for the summarization call, when one is
        needed.
    :param llm_client: LLM client for direct summarization. Ignored when
        *runner_client* is set.
    :param connection: Per-provider connection overrides, forwarded as-is.
    :param runner_client: Preferred path — delegates to the runner's own
        credentials, as in :func:`build_rollover_item`.
    :param conversation_id: The PARENT session's id (the summarization call
        runs against the parent's runner binding, not the not-yet-created
        fork's).
    :returns: A :class:`CompactionData` seed, ready to post as the fork's
        own ``compaction`` item.
    :raises ValueError: If *items* is empty.
    """
    # Raw session items include lifecycle entries the model never saw; keep the
    # parent's checkpoints, which the seed builds on.
    items = [
        item
        for item in items
        if item.get("type") == "compaction" or item.get("type") not in NON_CONTENT_ITEM_TYPES
    ]
    if not items:
        raise ValueError("build_side_chat_seed requires a non-empty parent record")
    # A reset forgot everything before it: seed from the reset onwards only.
    reset_index = next((i for i in range(len(items) - 1, -1, -1) if is_reset_item(items[i])), None)
    if reset_index is not None:
        items = items[reset_index:]
    # Stop at the parent's last finished reply: a Side Chat opened mid-turn
    # must not inherit (and act on) the request that is opening it.
    last_reply_index = next(
        (
            i
            for i in range(len(items) - 1, -1, -1)
            if items[i].get("type") == "message" and items[i].get("role") == "assistant"
        ),
        None,
    )
    if last_reply_index is not None:
        items = items[: last_reply_index + 1]
    else:
        # No assistant reply at all yet: still must not inherit the request
        # that's opening this fork — stop before the last USER message too
        # (unless that message is all there is, in which case there is
        # nothing left to seed from; keep it rather than seed from nothing).
        last_user_index = next(
            (
                i
                for i in range(len(items) - 1, -1, -1)
                if items[i].get("type") == "message" and items[i].get("role") == "user"
            ),
            None,
        )
        if last_user_index is not None and last_user_index > 0:
            items = items[:last_user_index]

    last_compaction_index = next(
        (i for i in range(len(items) - 1, -1, -1) if items[i].get("type") == "compaction"),
        None,
    )
    if last_compaction_index is None:
        return await build_rollover_item(
            items,
            previous_summary=None,
            keep_tokens=keep_tokens,
            model=model,
            llm_client=llm_client,
            connection=connection,
            runner_client=runner_client,
            conversation_id=conversation_id,
        )

    checkpoint = items[last_compaction_index]
    items_since = items[last_compaction_index + 1 :]
    if not items_since:
        # Nothing new since the parent's last checkpoint — reuse it verbatim
        # rather than re-summarizing zero material.
        return CompactionData(
            summary=checkpoint.get("summary", ""),
            last_item_id=checkpoint.get("last_item_id") or items[-1]["id"],
            model=checkpoint.get("model"),
            token_count=checkpoint.get("token_count", 0),
            compacted_messages=checkpoint.get("compacted_messages"),
        )
    return await build_rollover_item(
        items_since,
        previous_summary=checkpoint.get("summary"),
        keep_tokens=keep_tokens,
        model=model,
        llm_client=llm_client,
        connection=connection,
        runner_client=runner_client,
        conversation_id=conversation_id,
    )


async def build_side_chat_seed(
    items: list[dict[str, Any]],
    *,
    keep_tokens: int = DEFAULT_KEEP_TOKENS,
    model: str,
    llm_client: Any = None,
    connection: dict[str, str] | None = None,
    runner_client: Any | None = None,
    conversation_id: str | None = None,
) -> CompactionData:
    """:func:`_side_chat_checkpoint` with the side chat's own framing header.

    Takes the same arguments; the checkpoint's "this conversation grew past its
    limit" header would make the side chat believe it IS the main Conversation.
    """
    return _side_chat_framed(
        await _side_chat_checkpoint(
            items,
            keep_tokens=keep_tokens,
            model=model,
            llm_client=llm_client,
            connection=connection,
            runner_client=runner_client,
            conversation_id=conversation_id,
        )
    )


# ---------------------------------------------------------------------------
# Related chats: Muse-style chat.list for session_history's list_chats
# ---------------------------------------------------------------------------

_RELATED_CHATS_MAX = 20
# Forks of one session that are NOT side chats are filtered out below, so
# the raw fetch is capped higher than the returned limit.
_RELATED_CHATS_FETCH_CAP = 50
_RELATED_CHAT_PREVIEW_MAX_CHARS = 150


def _related_chat_preview(items: list[ConversationItem]) -> str | None:
    """Single-line text preview from newest-first message items of one chat.

    Mirrors the sub-agent rail's ``_latest_message_preview`` but kept local
    to this module — tools/builtins and the server route both need it and
    neither should import the other's helpers.
    """
    for item in items:
        if not isinstance(item.data, MessageData) or item.data.is_meta:
            continue
        parts = [
            block.get("text")
            for block in item.data.content
            if isinstance(block, dict)
            and block.get("type") in ("input_text", "output_text")
            and isinstance(block.get("text"), str)
        ]
        collapsed = " ".join(" ".join(parts).split())
        if not collapsed:
            continue
        if len(collapsed) <= _RELATED_CHAT_PREVIEW_MAX_CHARS:
            return collapsed
        return collapsed[: _RELATED_CHAT_PREVIEW_MAX_CHARS - 1].rstrip() + "…"
    return None


def side_chat_seed_checkpoint(
    conv_store: ConversationStore, conversation: Conversation
) -> tuple[str | None, str | None]:
    """``(summary, item_id)`` of a ``with_context`` Side Chat's seed, else ``(None, None)``.

    One items read, limited to the first ``compaction`` item — the seed
    ``build_side_chat_seed`` appends right after the fork's deep copy — so this
    stays cheap per related chat. The item id marks where the chat's own
    messages begin (everything before it is the copied parent record).
    """
    if conversation.labels.get(SIDE_CHAT_START_LABEL_KEY) != SIDE_CHAT_START_WITH_CONTEXT:
        return None, None
    # The deep copy carries the parent's own compactions BEFORE the seed, so the
    # first compaction is not the seed: pick the one stamped for this chat, falling
    # back to the first for seeds written without that response id.
    seed_response_id = f"rollover_seed_{conversation.id}"
    first = None
    item = None
    after: str | None = None
    while item is None:
        page = conv_store.list_items(
            conversation.id, limit=200, after=after, order="asc", type="compaction"
        )
        for candidate in page.data:
            if first is None:
                first = candidate
            if candidate.response_id == seed_response_id:
                item = candidate
                break
        if not page.has_more or not page.data:
            break
        after = page.last_id
    item = item or first
    if item is None:
        return None, None
    summary = item.data.summary if isinstance(item.data, CompactionData) else None
    return summary, item.id


def _chat_summary(
    conv_store: ConversationStore, conversation: Conversation, preview: str | None
) -> dict[str, Any]:
    seed_summary, seed_item_id = side_chat_seed_checkpoint(conv_store, conversation)
    return {
        "id": conversation.id,
        "title": conversation.title,
        "created_at": conversation.created_at,
        "updated_at": conversation.updated_at,
        "last_message_preview": preview,
        "archived": conversation.archived,
        # How it was opened (``ChatSummary.start``, docs/super-chat/WIRING.md);
        # ``None`` for the parent entry (the Super Chat itself never carries
        # the label) or a Side Chat from before this label existed.
        "start": conversation.labels.get(SIDE_CHAT_START_LABEL_KEY),
        "summary": seed_summary,
        "summary_body": person_facing_summary(seed_summary),
        "seed_item_id": seed_item_id,
        "live": conversation.live_status in _MID_TURN_LIVE_STATUSES,
    }


def list_related_chats(
    conv_store: ConversationStore,
    conversation_id: str,
    *,
    limit: int = _RELATED_CHATS_MAX,
) -> list[dict[str, Any]]:
    """
    The side chats related to *conversation_id* — Muse's ``chat.list`` for
    one session: side chats forked FROM it, plus its own parent when it is
    itself a side chat.

    Scoped to the SAME owner as *conversation_id*, resolved from the store
    (never an argument) exactly like ``resolve_memory_user`` scopes memory —
    a session merely shared with another user never surfaces as "related"
    to them, and a side chat opened before
    :data:`SIDE_CHAT_PARENT_LABEL_KEY` whose source lost its workspace-derived
    fork label is simply not found.

    :param conv_store: Store to query.
    :param conversation_id: The calling (source) session id.
    :param limit: Maximum chats to return.
    :returns: ``[{"id", "title", "created_at", "updated_at",
        "last_message_preview", "archived", "start", "summary", "summary_body", "seed_item_id",
        "live"},
        ...]``, newest-updated child first, parent last; ``[]`` when
        *conversation_id* does not exist.
    """
    caller = conv_store.get_conversation(conversation_id)
    if caller is None:
        return []
    owner_id = conv_store.get_session_owner(conversation_id)

    def same_owner(other_id: str) -> bool:
        other_owner_id = conv_store.get_session_owner(other_id)
        # A session with no owner grant reads back as ``None`` regardless of
        # who it actually belongs to. On a single-user server (no permission
        # store ever writing grants) every session reads back ``None``, and
        # they are all the one user's — that's the only case two ``None``s
        # may be treated as the same owner. Otherwise two unrelated sessions
        # that both happen to lack an owner grant must never match.
        if owner_id is None and other_owner_id is None:
            return local_single_user_enabled()
        return other_owner_id == owner_id

    related: list[Conversation] = []
    # Side Chats opened before SIDE_CHAT_PARENT_LABEL_KEY only carry the fork label.
    children: dict[str, Conversation] = {}
    for link in ({"side_chat_parent_id": conversation_id}, {"fork_source_id": conversation_id}):
        page = conv_store.list_conversations(
            limit=_RELATED_CHATS_FETCH_CAP,
            kind="default",
            order="desc",
            sort_by="updated_at",
            # Archived Side Chats stay readable; the ``archived`` flag lets a UI hide them.
            include_archived=True,
            **link,
        )
        children.update((child.id, child) for child in page.data)
    for child in sorted(children.values(), key=lambda c: c.updated_at, reverse=True):
        if SIDE_CHAT_LABEL_KEY in child.labels and same_owner(child.id):
            related.append(child)

    parent_id = side_chat_parent_id(caller.labels)
    if parent_id:
        parent = conv_store.get_conversation(parent_id)
        if parent is not None and same_owner(parent.id):
            related.append(parent)

    # A scheduled or ad-hoc Helper (Study, daily note) works for its parent chat and may
    # read it; an ordinary Sub-agent stays confined to its Brief.
    if (
        SCHEDULED_HELPER_LABEL_KEY in caller.labels or ADHOC_HELPER_LABEL_KEY in caller.labels
    ) and caller.parent_conversation_id:
        parent = conv_store.get_conversation(caller.parent_conversation_id)
        if parent is not None and same_owner(parent.id):
            related.append(parent)

    related = related[:limit]
    ids = [conversation.id for conversation in related]
    previews_by_id = conv_store.list_latest_message_items_for_conversations(ids, 10)
    return [
        _chat_summary(
            conv_store,
            conversation,
            _related_chat_preview(previews_by_id.get(conversation.id, [])),
        )
        for conversation in related
    ]


def related_chat_ids(conv_store: ConversationStore, conversation_id: str) -> frozenset[str]:
    """The ids ``list_related_chats`` would return, for a cheap membership check."""
    return frozenset(chat["id"] for chat in list_related_chats(conv_store, conversation_id))


# ---------------------------------------------------------------------------
# Post-compaction tail: what Claude Code and Codex lose on their own rollover
# ---------------------------------------------------------------------------

# Delimiters for the one-shot block prepended to the first delivered user
# message after a native CLI's own compaction (Claude Code, Codex). Wording
# makes clear to the model this is system-provided, not something the user typed.
_POST_COMPACTION_TAIL_HEADER = (
    "[Recent conversation before the context was compacted — verbatim, "
    "provided by the system, not a new message from the user]"
)
_POST_COMPACTION_TAIL_FOOTER = "[End of recent conversation]"


def _render_post_compaction_tail(items: list[dict[str, Any]]) -> str:
    """Render *items* as a delimited transcript block (see module docstring).

    Shares its message/tool-call/tool-result line shapes with
    :func:`_transcript_message`, but with plain ``User:``/``Assistant:`` role
    labels instead of the summarizer's ``<conversation>`` framing — this
    block is read by the CLI's own model, not a summarizer — and no extra
    output truncation: *items* already went through :func:`_cap_tool_outputs`,
    whose cap (and truncation note) must survive into the rendered text.
    """
    lines = [_POST_COMPACTION_TAIL_HEADER, ""]
    for item in items:
        kind = item.get("type")
        if kind == "message":
            role = "User" if item.get("role") == "user" else "Assistant"
            lines.append(f"{role}: {_block_text(item.get('content'))}")
        elif kind == "function_call":
            lines.append(f"Tool call {item.get('name')}: {item.get('arguments', '')}")
        elif kind == "function_call_output":
            lines.append(f"Tool result: {item.get('output', '')}")
    lines += ["", _POST_COMPACTION_TAIL_FOOTER]
    return "\n".join(lines)


def build_post_compaction_tail(
    items: list[dict[str, Any]],
    labels: Mapping[str, str] | None,
    *,
    model: str,
) -> str | None:
    """
    Build the once-per-compaction verbatim-tail block, or ``None``.

    Claude Code and Codex compact themselves at Omnigent's threshold, but
    their own compaction keeps less than Pi's (see ``rollover/README.md``):
    Claude Code keeps only its summary; Codex keeps its summary plus user
    text only. This reproduces Pi's (and Muse's) design elsewhere — a
    verbatim tail of the whole turns right before the boundary — from what
    Omnigent already recorded, so the next message delivered to the CLI
    can hand it back.

    :param items: The session's record, chronological, as flat item dicts
        (``compaction`` items included). Only the LATEST ``compaction``
        item matters; anything at or after it is ignored — the goal is to
        restore what its own CLI compaction discarded, not later turns.
    :param labels: The session's labels. Gated on
        :func:`~omnigent.context.labels.is_rollover`; also used for
        :func:`resolve_keep_tokens`.
    :param model: LLM model string, used to pick a tokenizer for the budget.
    :returns: The rendered block, or ``None`` when the session isn't a
        rollover session, no compaction has happened yet, or there is
        nothing to select (e.g. the compaction was the first record item).
    """
    if not is_rollover(labels):
        return None
    last_compaction_index = next(
        (i for i in range(len(items) - 1, -1, -1) if items[i].get("type") == "compaction"),
        None,
    )
    if last_compaction_index is None:
        return None
    # Allowlist, like session_history's _RECALL_ITEM_KINDS: reasoning and
    # lifecycle items (compaction, error, ...) are never part of the tail.
    preceding = [
        item
        for item in items[:last_compaction_index]
        if item.get("type") in _SUMMARIZER_INPUT_FIELDS
    ]
    if not preceding:
        return None
    recent = _cap_tool_outputs(
        select_recent(preceding, keep_tokens=resolve_keep_tokens(labels), model=model)
    )
    if not recent:
        return None
    return _render_post_compaction_tail(recent)


# session_id → id of the latest compaction item whose tail was already
# delivered. Module-level, process-lifetime, shared by every delivery path
# so a compaction is consumed once; a restart just re-delivers it once more.
_post_compaction_tail_consumed: dict[str, str] = {}


def consume_post_compaction_tail(
    items: list[dict[str, Any]],
    labels: Mapping[str, str] | None,
    *,
    session_id: str,
    model: str,
) -> str | None:
    """
    Build the post-compaction tail exactly once per compaction.

    Thin wrapper around :func:`build_post_compaction_tail` adding the
    once-per-compaction gate every delivery path shares: identifies the
    latest ``compaction`` item in *items* and, when *session_id* already
    consumed it, returns ``None`` without rebuilding or re-rendering.

    :param items: The session's record, chronological, as flat item dicts.
    :param labels: The session's labels.
    :param session_id: Session id — the once-per-compaction tracking key.
    :param model: LLM model string, used to pick a tokenizer for the budget.
    :returns: The rendered block the first time a compaction is seen for
        this session; ``None`` on a later call for the same compaction, or
        for any reason :func:`build_post_compaction_tail` itself returns
        ``None``.
    """
    compaction_id = next(
        (item.get("id") for item in reversed(items) if item.get("type") == "compaction"),
        None,
    )
    if not compaction_id or _post_compaction_tail_consumed.get(session_id) == compaction_id:
        return None
    _post_compaction_tail_consumed[session_id] = compaction_id
    return build_post_compaction_tail(items, labels, model=model)


def prefix_latest_user_item(items: list[dict[str, Any]], tail: str) -> list[dict[str, Any]]:
    """
    Prepend *tail* to the latest user message's text in raw session items.

    For callers that must apply a tail to flat session-item dicts (``type:
    "message"``, content blocks) rather than executor message shape — e.g.
    codex-native's resume-rollout rebuild. Returns a new list; *items* and
    its dicts are never mutated. A no-op when no user message is present.

    :param items: Chronological flat item dicts.
    :param tail: Text to prepend, e.g. a post-compaction tail block.
    :returns: *items* with the tail prepended to the latest user message.
    """
    prefix = f"{tail}\n\n"
    for i in range(len(items) - 1, -1, -1):
        item = items[i]
        if item.get("type") != "message" or item.get("role") != "user":
            continue
        content = item.get("content")
        if isinstance(content, str):
            new_content: Any = prefix + content
        elif isinstance(content, list):
            blocks = list(content)
            for j, block in enumerate(blocks):
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    blocks[j] = {**block, "text": prefix + block["text"]}
                    break
            else:
                blocks.insert(0, {"type": "input_text", "text": tail})
            new_content = blocks
        else:
            return items
        updated = list(items)
        updated[i] = {**item, "content": new_content}
        return updated
    return items
