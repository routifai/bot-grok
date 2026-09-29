"""Resolving who a private session belongs to.

Every primitive that reads or writes a person's durable Nova state from
inside a running session — a tool call, the elicitation bridge, the episode
observer — needs the same answer to "whose data is this": the session's
conversation, its scope label, and (if private) its owner. This is the
counterpart to :func:`~omnigent.nova._shared.identity.actor_from_request` for
code that has a conversation id instead of an HTTP request.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.nova._shared.identity import NovaActor
from omnigent.nova._shared.scope import Scope, scope_from_labels

if TYPE_CHECKING:
    from omnigent.stores import ConversationStore


def private_actor(
    conversation_id: str | None,
    *,
    conversation_store: ConversationStore | None = None,
) -> tuple[NovaActor | None, str | None]:
    """Resolve a private session's owner as a :class:`NovaActor`.

    Refuses unless the session exists, is labelled private, and has an
    explicit owner grant (``owner_only=True``): nothing durable is read or
    written for an ambiguous owner.

    :param conversation_id: The session, or ``None`` outside any session.
    :param conversation_store: The store to use; defaults to Omnigent's
        ambient one. The episode observer passes its own.
    :returns: ``(actor, None)``, or ``(None, reason)`` on refusal.
    """
    if conversation_id is None:
        return None, "no active session"

    if conversation_store is None:
        from omnigent.runtime import get_conversation_store

        conversation_store = get_conversation_store()

    conversation = conversation_store.get_conversation(conversation_id)
    if conversation is None:
        return None, "session not found"
    if scope_from_labels(conversation.labels or {}) is not Scope.PRIVATE:
        return None, "only available in a private session"

    owner = conversation_store.get_session_owner(conversation_id, owner_only=True)
    if owner is None:
        return None, "session has no owner"

    from omnigent.db.db_models import current_workspace_id

    return NovaActor(user_id=owner, workspace_id=current_workspace_id()), None
