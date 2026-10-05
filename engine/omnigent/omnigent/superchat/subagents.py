"""Sub-agents for ``superside-chat``: launch-by-Type, caps, Result delivery.

Pure decision logic for slice S3 (``rollover/SUPERSIDE-CHAT-PLAN.md``): the
async I/O (REST lookups, the wake POST) stays in ``omnigent/runner/app.py``
and ``omnigent/runner/tool_dispatch.py``; this module holds the gated,
testable rules those call sites apply. Everything here is a no-op outside
``superside-chat`` sessions — call sites gate on ``is_superside_chat``
before calling in, except where a function takes that fact as an argument.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterable, Mapping

from omnigent.util.session_lifecycle import is_session_closed

_logger = logging.getLogger(__name__)

# ── Default concurrency cap (across all Sub-agent Types, per tree) ────────

#: Env var overriding the default sub-agent concurrency cap for a
#: superside-chat tree. A Sub-agent Type's own ``max_sessions`` (from its
#: ``config.yaml``, parsed by ``omnigent/spec/parser.py::parse``) applies on
#: top of this, not instead of it.
DEFAULT_CONCURRENCY_ENV = "OMNIGENT_SUBAGENT_MAX_CONCURRENT"
DEFAULT_CONCURRENCY_CAP = 10


def resolve_default_concurrency_cap(env: Mapping[str, str] | None = None) -> int:
    """Resolve the default cross-type concurrency cap for a superside-chat tree.

    :param env: Environment mapping to read; ``os.environ`` when ``None``
        (tests pass a fake mapping instead of mutating process env).
    :returns: The configured cap, or :data:`DEFAULT_CONCURRENCY_CAP` when
        unset, non-integer, or non-positive.
    """
    source = env if env is not None else os.environ
    raw = source.get(DEFAULT_CONCURRENCY_ENV)
    if raw is None:
        return DEFAULT_CONCURRENCY_CAP
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_CONCURRENCY_CAP
    return value if value > 0 else DEFAULT_CONCURRENCY_CAP


def is_live_child_row(row: Mapping[str, object]) -> bool:
    """Whether a ``child_sessions`` row (:class:`ChildSessionSummary`) is still live.

    Mirrors the busy/queued/in_progress reading the rail uses: a closed
    child is never live regardless of these fields.

    :param row: One row as returned by ``GET /v1/sessions/{id}/child_sessions``.
    :returns: ``True`` when the child's turn is running or about to run.
    """
    labels = row.get("labels")
    title = row.get("title")
    if is_session_closed(
        labels if isinstance(labels, dict) else None,
        title if isinstance(title, str) else None,
    ):
        return False
    if row.get("busy") is True:
        return True
    return row.get("current_task_status") in ("queued", "in_progress")


def count_live_children(
    rows: Iterable[Mapping[str, object]],
    *,
    agent_type: str | None = None,
) -> int:
    """Count live (non-terminal, non-closed) child rows, optionally by Type.

    :param rows: ``child_sessions`` rows for one parent.
    :param agent_type: When given, count only children whose ``tool``
        (Sub-agent Type) matches; ``None`` counts every type.
    :returns: Number of matching live rows.
    """
    count = 0
    for row in rows:
        if agent_type is not None and row.get("tool") != agent_type:
            continue
        if is_live_child_row(row):
            count += 1
    return count


def refuse_subagent_concurrency(
    *,
    live_count_of_type: int,
    live_count_total: int,
    type_cap: int | None,
    default_cap: int,
) -> str | None:
    """Return why a new sub-agent dispatch must be refused, or ``None`` if allowed.

    Two independent caps, either can refuse: the Sub-agent Type's own
    ``max_sessions`` (counted against sub-agents of that one Type under the
    caller), and the tree-wide default (counted against every Sub-agent
    Type together) — see ``rollover/SUPERSIDE-CHAT-PLAN.md`` slice S3.

    :param live_count_of_type: Live children of the Type about to be
        dispatched.
    :param live_count_total: Live children of any Type under the caller.
    :param type_cap: The Type's own ``max_sessions``, or ``None`` when the
        Type declares no cap.
    :param default_cap: The tree-wide default cap
        (:func:`resolve_default_concurrency_cap`).
    :returns: An error message, or ``None`` when the dispatch may proceed.
    """
    if type_cap is not None and live_count_of_type >= type_cap:
        return (
            f"sub-agent concurrency cap reached for this Sub-agent Type: "
            f"{live_count_of_type}/{type_cap} already running"
        )
    if live_count_total >= default_cap:
        return (
            f"sub-agent concurrency cap reached: {live_count_total}/{default_cap} "
            "already running under this chat"
        )
    return None


# ── Nesting cap: chat (depth 0) -> Sub-agent (1) -> coordinator's child (2) ──


def refuse_subagent_nesting(*, caller_kind: str | None, parent_kind: str | None) -> str | None:
    """Return why a sub-agent launch must be refused for nesting, or ``None``.

    ``rollover/CONTEXT.md`` Relationships: "A Sub-agent launched by a chat
    may launch its own Sub-agents (acting as a coordinator); those cannot
    launch any further. At most two levels below a chat." The chat itself
    (``caller_kind != "sub_agent"``) and its direct Sub-agent (one level
    down) may launch; a Sub-agent whose own parent is already a Sub-agent
    (two levels down) may not.

    :param caller_kind: The calling session's ``Conversation.kind``.
    :param parent_kind: The calling session's parent's ``Conversation.kind``,
        or ``None`` when the caller has no parent (it is the chat) or the
        parent is unknown.
    :returns: An error message, or ``None`` when the launch may proceed.
    """
    if caller_kind != "sub_agent":
        return None
    if parent_kind == "sub_agent":
        return (
            "nesting cap reached: a sub-agent launched by another sub-agent "
            "(a coordinator's child) cannot launch further sub-agents — only "
            "the chat and its direct sub-agents may"
        )
    return None


# ── sys_session_create has no Type to pick a model for: no override at all ──


def refuse_subagent_dispatch_override(
    *, model: str | None, reasoning_effort: str | None
) -> str | None:
    """Return why a per-dispatch override must be refused, or ``None``.

    ``rollover/CONTEXT.md`` ("Sub-agent Type"): a superside-chat session
    launches a Sub-agent by its declared Type, never by naming a model —
    the Type's own ``config.yaml`` (model, reasoning effort) decides.

    :param model: The dispatch's requested ``model`` override, if any.
    :param reasoning_effort: The dispatch's requested ``reasoning_effort``
        override, if any.
    :returns: An error message, or ``None`` when neither override was given.
    """
    if model is not None:
        return (
            "model overrides are not allowed in superside-chat sessions; "
            "the Sub-agent Type's own config decides its model"
        )
    if reasoning_effort is not None:
        return (
            "reasoning_effort overrides are not allowed in superside-chat "
            "sessions; the Sub-agent Type's own config decides its "
            "reasoning effort"
        )
    return None


# ── Helper model choice: only ``fast`` or ``strong``, mapped in config ────

#: Env vars mapping the two choices to real model ids; the product sets them. A choice with no
#: id configured inherits the parent session's model (the existing inheritance). Model ids
#: never appear in prompts.
#:
#: The unsuffixed ids belong to the single-vendor harnesses (Claude SDK, codex, ...), whose
#: vocabulary they are written in. A multi-model harness (``pi``) has no vendor to match them
#: against, so it reads only its own ``<VAR>_<HARNESS>`` id (e.g. ``..._FAST_PI``) and
#: otherwise inherits the parent's model: a Claude id from the global setting never reaches a
#: Helper running on a GPT-class parent model.
FAST_MODEL_ENV = "OMNIGENT_HELPER_MODEL_FAST"
STRONG_MODEL_ENV = "OMNIGENT_HELPER_MODEL_STRONG"
HELPER_MODEL_CHOICES = ("fast", "strong")
HELPER_EFFORT_CHOICES = ("low", "medium", "high")


def _is_multi_model_harness(harness: str) -> bool:
    from omnigent.harness_aliases import canonicalize_harness
    from omnigent.harness_capabilities import ModelFamily
    from omnigent.harness_plugins import harness_capabilities

    capabilities = harness_capabilities().get(canonicalize_harness(harness) or harness)
    return capabilities is not None and capabilities.model_family is ModelFamily.MULTI


def helper_model_id(choice: str, harness: str | None, env: Mapping[str, str]) -> str | None:
    """The configured model id behind ``fast``/``strong`` for a Helper on ``harness``.

    :param choice: ``"fast"`` or ``"strong"``.
    :param harness: The Helper's harness (e.g. ``"claude-sdk"``, ``"pi"``); ``None`` when
        unknown, which reads the global ids.
    :param env: Environment mapping to read.
    :returns: The id, or ``None`` for "inherit the parent's model".
    """
    base = FAST_MODEL_ENV if choice == "fast" else STRONG_MODEL_ENV
    if harness is not None:
        from omnigent.harness_aliases import canonicalize_harness

        canonical = canonicalize_harness(harness) or harness
        scoped = env.get(f"{base}_{re.sub(r'[^A-Za-z0-9]+', '_', canonical).upper()}")
        if scoped:
            return scoped
        if _is_multi_model_harness(canonical):
            return None
    return env.get(base) or None


def resolve_helper_dispatch(
    *,
    model: str | None,
    reasoning_effort: str | None,
    harness: str | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[str | None, str | None]:
    """Map a Super Chat dispatch's ``fast``/``strong`` choice to a model id.

    :param model: The dispatch's ``model`` argument: ``None``, ``"fast"`` or ``"strong"``.
    :param reasoning_effort: The dispatch's reasoning level: ``None``, ``low``, ``medium`` or
        ``high``.
    :param harness: The harness the Helper runs on, which decides whose ids apply
        (:func:`helper_model_id`).
    :param env: Environment mapping to read; ``os.environ`` when ``None``.
    :returns: ``(model_id, reasoning_effort)``; ``model_id`` is ``None`` for "inherit the
        parent's model" (nothing configured for this harness, or no choice made).
    :raises ValueError: When the choice is anything else; the message is shown to the model.
    """
    source = env if env is not None else os.environ
    if reasoning_effort is not None and reasoning_effort not in HELPER_EFFORT_CHOICES:
        raise ValueError(
            f"reasoning_effort must be one of {', '.join(HELPER_EFFORT_CHOICES)} in this chat"
        )
    if model is None:
        return None, reasoning_effort
    if model in HELPER_MODEL_CHOICES:
        return helper_model_id(model, harness, source), reasoning_effort
    raise ValueError(f"model must be 'fast' or 'strong' in this chat, not {model!r}")


# ── Retired Helper types and background model ─────────────────────────────

#: Helper types replaced by the general ``worker`` (ADR 0007). Tasks stored with one of these
#: (followed topics, the daily study, quiet-moment passes) keep running as a ``worker``.
RETIRED_HELPER_TYPES = frozenset({"researcher", "analyst", "drafter"})
WORKER_TYPE = "worker"


def scheduled_helper_type(agent_type: str) -> str:
    """The Type a stored Helper Type runs as: a retired Type runs as ``worker``."""
    return WORKER_TYPE if agent_type in RETIRED_HELPER_TYPES else agent_type


def resolve_scheduled_helper(
    agent_type: str,
    model_override: str | None,
    env: Mapping[str, str] | None = None,
    *,
    harness: str | None = None,
) -> tuple[str, str | None]:
    """The Type and model a scheduled or background Helper really runs with.

    A retired Type runs as ``worker``. Background work is pinned to the fast model unless the
    task names ``fast`` or ``strong``; a Type's own ``config.yaml`` pin still applies on top.

    :param agent_type: The stored Sub-agent Type, e.g. ``"researcher"``.
    :param model_override: The stored per-run model: ``None``, ``fast``, ``strong`` or a model id.
    :param env: Environment mapping for the fast/strong ids; ``os.environ`` when ``None``.
    :param harness: The harness the resolved Type runs on (the bundle's choice), which decides
        whose fast/strong ids apply, as for a dispatch.
    :returns: ``(type, model_override)`` to run with; ``None`` means inherit the parent's model.
    """
    resolved_type = scheduled_helper_type(agent_type)
    if model_override in HELPER_MODEL_CHOICES or model_override is None:
        model_override, _ = resolve_helper_dispatch(
            model=model_override or "fast", reasoning_effort=None, harness=harness, env=env
        )
    return resolved_type, model_override


# ── Brief + Memory Profile (hook for slice S6) ─────────────────────────────


def prepend_memory_profile(message: str, profile: str | None) -> str:
    """Prepend a Memory Profile block to a sub-agent's first message (Brief).

    :param message: The Brief text as written by the Originating Chat.
    :param profile: The user's delimited Memory Profile block (the server's
        ``GET /v1/sessions/{id}/memory/profile``); a no-op when
        ``None`` or empty.
    :returns: ``message``, with the profile block prepended when given.
    """
    if not profile:
        return message
    return f"{profile}\n\n{message}"


# ── Result delivered in the wake, instead of only "N results waiting" ─────

#: Characters of a sub-agent's Result kept verbatim in the wake notice
#: before pointing the parent at the full transcript instead.
RESULT_PREVIEW_MAX_CHARS = 4000


def format_subagent_wake_notice_with_result(
    *,
    agent: str,
    title: str,
    status: str,
    child_session_id: str,
    result_text: str | None,
    max_chars: int = RESULT_PREVIEW_MAX_CHARS,
    saved_files: str = "",
) -> str:
    """Build a superside-chat wake notice that inlines the Result itself.

    ``rollover/CONTEXT.md`` ("Result"): the sub-agent's final message is
    "the only thing a chat receives from a sub-agent without asking" — so
    for a superside-chat parent the wake carries that message directly
    rather than only "N results waiting in inbox".

    :param agent: Sub-agent Type name, e.g. ``"researcher"``.
    :param title: Sub-agent instance title, e.g. ``"auth"``.
    :param status: Terminal status, e.g. ``"completed"``.
    :param child_session_id: The sub-agent's session id, so the parent can
        read more when the Result was capped.
    :param result_text: The sub-agent's final message. ``None``/empty
        renders as ``"(no output)"``.
    :param max_chars: Cap on verbatim Result text kept in the notice.
    :param saved_files: The block naming files the Helper saved (``format_saved_files``), if any.
    :returns: A ``[System: ...]`` notice string with the Result inlined.
    """
    text = (result_text or "").strip() or "(no output)"
    if len(text) > max_chars:
        body = (
            f"{text[:max_chars]}... [truncated; call sys_session_get_history "
            f"with conversation_id={child_session_id!r} to read the rest]"
        )
    else:
        body = text
    return (
        f"[System: sub-agent {agent}/{title} finished ({status}) — result:\n{body}\n{saved_files}"
        "Use this Result to complete what the person originally asked for: deliver the finished "
        "thing (the answer, comparison or draft, as a card or file if that fits), not a status "
        "update. Mention anything still open in one line. Do not raise unrelated topics.]"
    )


# ── Archived Originating Side Chat: redirect the Result to its Super Chat ─


def resolve_wake_target(
    *,
    parent_id: str,
    archived: bool,
    is_side_chat: bool,
    fork_source_id: str | None,
) -> tuple[str, str | None]:
    """Resolve where a sub-agent's wake/Result should actually be delivered.

    ``rollover/CONTEXT.md`` ("Originating Chat", "Archived"): a Side Chat is
    hidden once archived, not deleted; the Result of work it launched still
    reaches the user, so it is redirected to the Super Chat instead
    (resolved from the Side Chat's ``omnigent.fork.source_id`` label).

    :param parent_id: The sub-agent's recorded Originating Chat id.
    :param archived: Whether that chat is currently archived.
    :param is_side_chat: Whether that chat carries the Side Chat label.
    :param fork_source_id: That chat's ``omnigent.fork.source_id`` label
        (its Super Chat), when present.
    :returns: ``(target_session_id, note)`` — ``target_session_id`` is
        ``parent_id`` unchanged unless redirected; ``note`` is ``None``
        unless a redirect happened, in which case it names the archived
        Side Chat for the Super Chat reader.
    """
    if archived and is_side_chat and fork_source_id:
        return fork_source_id, (
            f"[System: this result's Originating Chat ({parent_id}) is an "
            "archived Side Chat; delivering it here, to its Super Chat, "
            "instead.]"
        )
    if archived and is_side_chat:
        # Missing the fork-source label (see FORK_SOURCE_LABEL_KEY's "not a
        # complete fork index" caveat): there is no Super Chat to redirect
        # to, so the wake still delivers to the archived chat itself — just
        # not silently, since that chat is hidden from the user's chat list.
        _logger.warning(
            "sub-agent wake delivered to an archived Side Chat with no fork_source label: %s",
            parent_id,
            extra={"session_id": parent_id},
        )
    return parent_id, None
