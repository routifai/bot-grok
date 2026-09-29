"""Where a session sits, which decides what private data it may see."""

from __future__ import annotations

from collections.abc import Mapping
from enum import StrEnum

SCOPE_LABEL = "nova.scope"


class Scope(StrEnum):
    """The privacy scope of a session.

    ``PRIVATE`` is the person's own Conversation, Goals and routines: it may
    read their notes, episodes and Goals. ``PROJECT`` is a shared project: it
    sees only the project, never anyone's private data.
    """

    PRIVATE = "private"
    PROJECT = "project"


def scope_from_labels(labels: Mapping[str, str]) -> Scope:
    """Read a session's scope from its labels.

    Only an explicit ``nova.scope=private`` is private. A missing or
    unrecognised label is ``PROJECT``, so an unlabelled session (any
    non-Nova Omnigent session, or a shared one) never sees private data.

    :param labels: The session's conversation labels.
    :returns: The scope.
    """
    if labels.get(SCOPE_LABEL) == Scope.PRIVATE.value:
        return Scope.PRIVATE
    return Scope.PROJECT
