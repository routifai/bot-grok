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

    Anything unrecognised is treated as ``PROJECT``, so a mislabelled session
    can only ever see less, never more.

    :param labels: The session's conversation labels.
    :returns: The scope.
    """
    value = labels.get(SCOPE_LABEL, Scope.PRIVATE.value)
    return Scope.PRIVATE if value == Scope.PRIVATE.value else Scope.PROJECT
