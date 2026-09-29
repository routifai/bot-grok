"""What the server hands every Nova primitive when it mounts it."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from omnigent.server.auth import AuthProvider
    from omnigent.stores import ConversationStore


@dataclass(frozen=True)
class NovaDeps:
    """Server-owned dependencies, built once in ``create_app``.

    :param storage_location: Database URI of the Omnigent operational tables;
        every Nova store is built from it.
    :param auth_provider: Resolves the caller's identity on a request, or
        ``None`` when the server runs without auth.
    :param conversation_store: Omnigent's session store, for primitives that
        link to sessions (Goals run in their own session, Asks point at one).
    """

    storage_location: str
    auth_provider: AuthProvider | None
    conversation_store: ConversationStore | None = None
