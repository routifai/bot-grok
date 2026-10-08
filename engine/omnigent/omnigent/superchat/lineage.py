"""Where a session sits in a Super Chat family: its kind, root, parent, seed and open Project.

Shared by the transcript route and the session snapshot (``GET /v1/sessions/{id}``), so a client
holding only a session id can tell a Super Chat from a Side Chat or a Helper without its own map.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any

from omnigent.context.labels import is_superside_chat
from omnigent.context.rollover import side_chat_seed_checkpoint
from omnigent.entities import Conversation
from omnigent.stores import ConversationStore
from omnigent.stores.conversation_store import side_chat_parent_id
from omnigent.superchat.feature import is_helper, is_super_chat
from omnigent.superchat.projects.card import project_slug_from_workspace
from omnigent.superchat.side_chats.forks import fork_anchor_id, fork_parent_id

_MAX_HELPER_HOPS = 8

#: Session label holding the open Project's card name, stamped when ``open_project`` moves the
#: working directory (the card itself lives on the session's host, not the server).
PROJECT_NAME_LABEL_KEY = "omnigent.project.name"

#: A Side Chat's seed item never changes once written, so a found id is cached (bounded) and
#: the session snapshot, which clients poll, pays the items read once per chat per process.
_SEED_CACHE_MAX = 4096
_seed_cache: OrderedDict[str, str] = OrderedDict()


def _cached_seed_item_id(conv_store: ConversationStore, conversation: Conversation) -> str | None:
    cached = _seed_cache.get(conversation.id)
    if cached is not None:
        _seed_cache.move_to_end(conversation.id)
        return cached
    _, seed_item_id = side_chat_seed_checkpoint(conv_store, conversation)
    if seed_item_id is not None:
        _seed_cache[conversation.id] = seed_item_id
        if len(_seed_cache) > _SEED_CACHE_MAX:
            _seed_cache.popitem(last=False)
    return seed_item_id


def _helper_root(conv_store: ConversationStore, conversation: Conversation) -> Conversation | None:
    """The top-level session a Helper's spawn tree hangs off (one read when the row knows it)."""
    root_id = conversation.root_conversation_id
    if root_id and root_id != conversation.id:
        return conv_store.get_conversation(root_id)
    root = conversation
    for _ in range(_MAX_HELPER_HOPS):
        if root.kind != "sub_agent" or not root.parent_conversation_id:
            break
        parent = conv_store.get_conversation(root.parent_conversation_id)
        if parent is None:
            break
        root = parent
    return root


def _super_chat_id_of(root: Conversation) -> str | None:
    """A top-level chat's Super Chat: a Side Chat's parent, else itself (``None`` for a Helper)."""
    if root.kind == "sub_agent":
        return None
    return side_chat_parent_id(root.labels) or root.id


def session_lineage(
    conv_store: ConversationStore,
    conversation: Conversation,
    *,
    helper_root: Conversation | None = None,
) -> dict[str, Any]:
    """Where a session sits: ``kind`` (``super`` / ``side`` / ``helper`` / ``None``), its root.

    :param helper_root: A Helper's already-read root, to skip reading it again.
    :returns: ``{"kind", "root_id", "parent_id", "seed_item_id", "anchor_item_id"}``;
        ``seed_item_id`` is the checkpoint a with-context Side Chat starts after. A Fork's
        ``anchor_item_id`` is the message it started from, and its ``parent_id`` the chat
        holding it (a fork of a fork's parent is that fork; its root is still the Super Chat).
    """
    labels = conversation.labels
    lineage: dict[str, Any] = {
        "kind": None,
        "root_id": None,
        "parent_id": None,
        "seed_item_id": None,
        "anchor_item_id": None,
    }
    if conversation.kind == "sub_agent" or is_helper(labels):
        root = helper_root or _helper_root(conv_store, conversation) or conversation
        lineage.update(
            kind="helper",
            root_id=_super_chat_id_of(root),
            parent_id=conversation.parent_conversation_id,
        )
    elif (parent := side_chat_parent_id(labels)) is not None:
        lineage.update(
            kind="side",
            root_id=parent,
            parent_id=fork_parent_id(labels) or parent,
            seed_item_id=_cached_seed_item_id(conv_store, conversation),
            anchor_item_id=fork_anchor_id(labels),
        )
    elif is_super_chat(labels):
        lineage.update(kind="super", root_id=conversation.id)
    return lineage


def is_super_chat_helper(conv_store: ConversationStore, conversation: Conversation) -> bool:
    """True for a Helper of a Super Chat family (a sub-agent whose spawn tree is ``superside``)."""
    if conversation.kind != "sub_agent":
        return False
    root = _helper_root(conv_store, conversation)
    return root is not None and is_superside_chat(root.labels)


def open_project(conversation: Conversation) -> dict[str, str] | None:
    """The Project the session has open (``{"slug", "name"}``), read from its working directory.

    The name is the card name ``open_project`` recorded, else the slug.
    """
    slug = project_slug_from_workspace(conversation.workspace)
    if slug is None:
        return None
    name = conversation.labels.get(PROJECT_NAME_LABEL_KEY) or slug
    return {"slug": slug, "name": name}


def session_superchat(
    conv_store: ConversationStore, conversation: Conversation
) -> dict[str, Any] | None:
    """The ``superchat`` block of a session snapshot, or ``None`` outside a Super Chat family.

    No store read for a plain session; one for a Helper (its root); a Side Chat's seed is read
    once and cached.
    """
    root: Conversation | None = None
    if conversation.kind == "sub_agent":
        root = _helper_root(conv_store, conversation)
        if root is None or not is_superside_chat(root.labels):
            return None
    elif not is_superside_chat(conversation.labels):
        return None
    lineage = session_lineage(conv_store, conversation, helper_root=root)
    if lineage["kind"] is None:
        return None
    return {**lineage, "project": open_project(conversation)}
