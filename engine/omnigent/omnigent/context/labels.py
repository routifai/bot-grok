"""Session labels that switch context ownership between the CLI and Omnigent.

``omnigent.context.mode`` selects the lifecycle: unset means upstream
behavior, untouched; ``"rollover"`` means each native CLI compacts its own
context at Omnigent's threshold, and the session gets the recall tool and
instruction; ``"superside-chat"`` means the Super Chat, its Side Chats and
Sub-agents run on the Claude SDK engine with Omnigent owning context,
sub-agents and memory. See ``rollover/README.md`` and
``rollover/SUPERSIDE-CHAT-PLAN.md``.
"""

from __future__ import annotations

from collections.abc import Mapping

#: Session label selecting how context is managed. Unset means the CLI
#: owns its own context (upstream behaviour, unchanged).
CONTEXT_MODE_LABEL = "omnigent.context.mode"

#: ``CONTEXT_MODE_LABEL`` value for the rollover super chat: Omnigent, not
#: the CLI, decides what the model carries forward.
ROLLOVER_MODE_VALUE = "rollover"

#: ``CONTEXT_MODE_LABEL`` value for the Super Chat, its Side Chats and its
#: Sub-agents on the Claude SDK engine. Distinct from ``ROLLOVER_MODE_VALUE``
#: (native CLIs): a session is in exactly one mode. See
#: ``rollover/CONTEXT.md``.
SUPERSIDE_CHAT_MODE_VALUE = "superside-chat"

#: Child-session label carrying the dispatch id of the turn a sub-agent runs;
#: lets a parent recover a Result it never drained.
SUBAGENT_DISPATCH_ID_LABEL_KEY = "omnigent.subagent.dispatch_id"

#: Runner-side marker (never stored) added to the tool-gating labels of a
#: sub-agent session, so top-level-only tools are not offered to it.
SUBAGENT_LABEL_KEY = "omnigent.subagent"

#: Stamped on a Helper session created by a parent-bound scheduled fire; its
#: value is the scheduled task id. The runner registers such a child's Result
#: for the parent wake on its first turn.
SCHEDULED_HELPER_LABEL_KEY = "omnigent.subagent.scheduled_task_id"

#: Stamped by the server on every child session when it creates it. It means "launched, no
#: status reported yet": the Activity Feed reads such a child as starting (and, if it never
#: reports one, as failed to start) instead of guessing from age alone. Inert once the child
#: has a ``live_status``.
LAUNCHING_LABEL_KEY = "omnigent.subagent.launching"

#: Stamped on an ad-hoc Helper (``start_adhoc_helper``: the daily-note pass). It does not wake
#: its parent, but like a scheduled Helper it may read the parent chat (``session_history``).
ADHOC_HELPER_LABEL_KEY = "omnigent.subagent.adhoc"

#: Stamped on a standalone session a scheduled fire created (not parent-bound);
#: its value is the scheduled task id. Its first user message is the task's
#: system-authored prompt, so memory upkeep never treats it as the person's words.
SCHEDULED_FIRE_LABEL_KEY = "omnigent.scheduled_task_id"

# Token count at which a rollover session rolls over. Unset falls back to
# 60% of the model's context window (100k-200k), or 100,000 when unknown
# (see rollover.resolve_rollover_threshold).
ROLLOVER_AT_TOKENS_LABEL = "omnigent.context.rollover_at_tokens"

# Token budget for the kept tail (whole turns only; the last turn is always kept; see
# rollover.select_recent). Unset -> DEFAULT_KEEP_TOKENS.
ROLLOVER_KEEP_TOKENS_LABEL = "omnigent.context.rollover_keep_tokens"
DEFAULT_KEEP_TOKENS = 16_000


def is_rollover(labels: Mapping[str, str] | None) -> bool:
    """Whether a session's labels select rollover (Omnigent-owned) context.

    :param labels: The session's labels, or ``None``.
    :returns: ``True`` only when ``CONTEXT_MODE_LABEL`` is exactly
        ``"rollover"``.
    """
    if not labels:
        return False
    return labels.get(CONTEXT_MODE_LABEL) == ROLLOVER_MODE_VALUE


def is_superside_chat(labels: Mapping[str, str] | None) -> bool:
    """Whether a session's labels select superside-chat mode.

    :param labels: The session's labels, or ``None``.
    :returns: ``True`` only when ``CONTEXT_MODE_LABEL`` is exactly
        ``"superside-chat"``.
    """
    if not labels:
        return False
    return labels.get(CONTEXT_MODE_LABEL) == SUPERSIDE_CHAT_MODE_VALUE


def uses_omnigent_context(labels: Mapping[str, str] | None) -> bool:
    """Whether a session is in either Omnigent-owned context mode.

    The shared gate for behaviour both modes use (``session_history``, the
    ``memory_*`` tool family): ``rollover`` (native CLIs) and
    ``superside-chat`` (the Super Chat on the Claude SDK engine) both hand
    context ownership to Omnigent, so both get it. Behaviour specific to one
    mode (engine-feature toggles, which compaction mechanism runs) stays
    gated on :func:`is_rollover` / :func:`is_superside_chat` individually,
    never on this helper.

    :param labels: The session's labels, or ``None``.
    :returns: ``True`` when ``CONTEXT_MODE_LABEL`` is ``"rollover"`` or
        ``"superside-chat"``.
    """
    return is_rollover(labels) or is_superside_chat(labels)


# Every label that configures rollover mode for a session. A side chat forked
# from the super chat KEEPS these — it stays a rollover session, seeded from
# the parent's checkpoint rather than dropped back to upstream behavior. Also
# the set a superside-chat session forwards to a sub-agent it creates (see
# ``inheritable_context_labels``): the keys are mode-agnostic, so the same
# set covers a rollover session's tuning labels and a superside-chat
# session's mode label alike.
ROLLOVER_SESSION_LABELS: frozenset[str] = frozenset(
    {
        CONTEXT_MODE_LABEL,
        ROLLOVER_AT_TOKENS_LABEL,
        ROLLOVER_KEEP_TOKENS_LABEL,
    }
)


def inheritable_context_labels(labels: Mapping[str, str] | None) -> dict[str, str]:
    """Filter *labels* down to the ones a created-from-scratch child inherits.

    A fork copies the source's labels wholesale (store-level drop list only)
    and needs no filtering. A sub-agent create instead sends a fresh label
    set to the server, so the mode must be forwarded explicitly — and only
    the mode label plus its rollover tuning labels
    (:data:`ROLLOVER_SESSION_LABELS`), never arbitrary session labels (e.g.
    presentation or permission-mode labels, which are instance-scoped to the
    parent).

    :param labels: The creating session's labels, or ``None``.
    :returns: The subset of *labels* whose keys are in
        :data:`ROLLOVER_SESSION_LABELS`; ``{}`` when *labels* is ``None`` or
        empty, or has no matching keys.
    """
    if not labels:
        return {}
    return {key: value for key, value in labels.items() if key in ROLLOVER_SESSION_LABELS}
