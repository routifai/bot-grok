"""Side Chats: open, discover, and auto-archive them.

A Side Chat is a short-lived branch of the Super Chat (``rollover/CONTEXT.md``).
Only the Super Chat may open one — never a Side Chat, never a Sub-agent — and
it starts ``with_context`` (a rollover fork, seeded from the parent's
checkpoint) or ``blank`` (a fresh top-level session carrying the mode label
and the same discovery labels, with no copied transcript). Side Chats are
archived after inactivity, never deleted, and unarchive on the next user
message (see :func:`maybe_unarchive_on_user_message`).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

from omnigent.context.labels import (
    CONTEXT_MODE_LABEL,
    SUPERSIDE_CHAT_MODE_VALUE,
    is_superside_chat,
)
from omnigent.entities import ConversationItem
from omnigent.stores.conversation_store import (
    SIDE_CHAT_LABEL_KEY,
    SIDE_CHAT_START_LABEL_KEY,
    ConversationStore,
)

_logger = logging.getLogger(__name__)

# ── side_chat_open: eligibility + request bodies ──────────────────────────

SIDE_CHAT_START_WITH_CONTEXT = "with_context"
SIDE_CHAT_START_BLANK = "blank"
SIDE_CHAT_START_VALUES = frozenset({SIDE_CHAT_START_WITH_CONTEXT, SIDE_CHAT_START_BLANK})


def refuse_side_chat_open(
    *,
    labels: Mapping[str, str] | None,
    kind: str | None,
    parent_session_id: str | None,
) -> str | None:
    """Return why ``side_chat_open`` must be refused, or ``None`` if allowed.

    Side Chats branch only from the Super Chat (``rollover/CONTEXT.md``
    Relationships): never from another Side Chat, never from a Sub-agent.
    Tool registration already gates ``side_chat_open`` to superside-chat
    sessions (:class:`omnigent.tools.manager.ToolManager`); this call-time
    check refuses the two callers that pass that gate but aren't the Super
    Chat itself.

    :param labels: The calling session's own labels.
    :param kind: The calling session's ``Conversation.kind`` (``"sub_agent"``
        for a Sub-agent).
    :param parent_session_id: The calling session's
        ``parent_conversation_id``, when any — set for every Sub-agent.
    :returns: An error message, or ``None`` when the caller is the Super
        Chat and may open a Side Chat.
    """
    if not is_superside_chat(labels):
        return "side_chat_open is only available in superside-chat sessions"
    if SIDE_CHAT_LABEL_KEY in (labels or {}):
        return "side_chat_open can only be called from the Super Chat, not from a Side Chat"
    if kind == "sub_agent" or parent_session_id:
        return "side_chat_open can only be called from the Super Chat, not from a Sub-agent"
    return None


def build_side_chat_fork_body(
    title: str | None, *, anchor: ConversationItem | None = None
) -> dict[str, object]:
    """``POST /v1/sessions/{super_chat_id}/fork`` body for ``with_context``.

    ``side_chat: true`` makes the server stamp :data:`SIDE_CHAT_LABEL_KEY`,
    keep the rollover-mode labels, and — since the source is a rollover
    session — seed the fork from the parent's checkpoint instead of its full
    transcript (``routes_core.fork_session`` / ``_seed_rollover_side_chat``).
    A Fork's *anchor* ends the seed at that item and stops the copy at the
    end of its turn, so nothing later than that turn reaches the new chat.
    Without a *title* it is sent empty, not omitted: the chat stays untitled
    (never ``"Fork of …"``) so its first message titles it in the background.
    """
    body: dict[str, object] = {"side_chat": True, "title": title or ""}
    if anchor is not None:
        body["side_chat_anchor_item_id"] = anchor.id
        if anchor.response_id:
            body["up_to_response_id"] = anchor.response_id
    return body


def build_side_chat_blank_create_body(
    *,
    agent_id: str,
    title: str | None,
) -> dict[str, object]:
    """``POST /v1/sessions`` body for a ``blank`` Side Chat.

    Not a fork: a fresh top-level session with no copied transcript, bound
    to the same agent as the Super Chat. Stamped with :data:`SIDE_CHAT_LABEL_KEY`
    (what ``list_related_chats`` discovers a Side Chat by), the superside-chat mode
    label so it carries the same capability, and :data:`SIDE_CHAT_START_LABEL_KEY`
    so ``list_related_chats`` can report how it started. The parent link is
    stamped by the open route, for blank and forked Side Chats alike.
    """
    body: dict[str, object] = {
        "agent_id": agent_id,
        "labels": {
            CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE,
            SIDE_CHAT_LABEL_KEY: "1",
            SIDE_CHAT_START_LABEL_KEY: SIDE_CHAT_START_BLANK,
        },
    }
    if title:
        body["title"] = title
    return body


# ── Auto-archive age default (the sweep itself is in ``archiving``) ───────────

ARCHIVE_AFTER_SECONDS_ENV = "OMNIGENT_SIDE_CHAT_ARCHIVE_AFTER_SECONDS"
#: 30 days in production. Set to 3600 (one hour) for testing.
DEFAULT_ARCHIVE_AFTER_SECONDS = 30 * 24 * 60 * 60


def resolve_archive_after_seconds() -> int:
    """Resolve the Side Chat inactivity period before auto-archive.

    Reads :data:`ARCHIVE_AFTER_SECONDS_ENV`, default
    :data:`DEFAULT_ARCHIVE_AFTER_SECONDS` (30 days); set it to ``3600`` (one
    hour) for testing. A missing, non-integer, or non-positive value falls
    back to the default rather than archiving everything on the next sweep.
    """
    raw = os.environ.get(ARCHIVE_AFTER_SECONDS_ENV)
    if raw is None:
        return DEFAULT_ARCHIVE_AFTER_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_ARCHIVE_AFTER_SECONDS
    return value if value > 0 else DEFAULT_ARCHIVE_AFTER_SECONDS


def maybe_unarchive_on_user_message(
    conv_store: ConversationStore,
    conversation_id: str,
) -> bool:
    """Unarchive a Side Chat that just received a new user message.

    Decision (documented, not just implemented): a message to an archived
    Side Chat unarchives it — the user is resuming it on purpose, and
    Archived only means "hidden from the list, not ended"
    (``rollover/CONTEXT.md``, **Archived**). No-op for the Super Chat, a
    Sub-agent, an already-active Side Chat, or an unknown conversation.

    :returns: ``True`` iff this call unarchived the conversation.
    """
    conversation = conv_store.get_conversation(conversation_id)
    if conversation is None or not conversation.archived:
        return False
    if SIDE_CHAT_LABEL_KEY not in conversation.labels:
        return False
    conv_store.update_conversation(conversation_id, archived=False)
    return True
