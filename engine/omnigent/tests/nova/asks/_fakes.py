"""Test doubles shared across the Asks test suite.

Not itself a test module (no ``test_`` prefix); imported by the ones below.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from omnigent.nova.asks.entities import Ask, AskStatus
from omnigent.nova.asks.store import AskStore


def uid(seed: str) -> str:
    """Deterministic bare 32-char hex id from a short readable seed.

    ``nova_asks.session_id`` (and Omnigent's own conversation ids) are
    ``Uuid16`` columns, which reject anything that isn't 32 hex characters
    (or a recognised ``<prefix>_<hex>`` legacy id) — mirrors the
    project_store tests' own ``_uid`` helper so short, readable seeds like
    ``"conv_1"`` still round-trip through a real database.
    """
    return uuid.uuid5(uuid.NAMESPACE_DNS, seed).hex


@dataclass
class FakeConversation:
    """Just enough of :class:`~omnigent.entities.conversation.Conversation` for scoping."""

    labels: dict[str, str] = field(default_factory=dict)


@dataclass
class FakeConversationStore:
    """A minimal stand-in for :class:`~omnigent.stores.ConversationStore`.

    Covers exactly what ``bridge.py`` and ``tools.py`` touch: reading a
    session's labels/owner, and (for the stale-elicitation fallback)
    appending a message. No real database — a plain dict underneath.
    """

    storage_location: str
    owners: dict[str, str] = field(default_factory=dict)
    labels: dict[str, dict[str, str]] = field(default_factory=dict)
    appended: list[tuple[str, list[Any]]] = field(default_factory=list)

    def get_conversation(self, conversation_id: str) -> FakeConversation | None:
        if conversation_id not in self.owners:
            return None
        return FakeConversation(labels=self.labels.get(conversation_id, {}))

    def get_session_owner(self, conversation_id: str, *, owner_only: bool = False) -> str | None:
        del owner_only
        return self.owners.get(conversation_id)

    def append(self, conversation_id: str, items: list[Any]) -> list[Any]:
        self.appended.append((conversation_id, items))
        return items


class InMemoryAskStore(AskStore):
    """A plain-dict :class:`AskStore`, for testing ``AskService`` without a database."""

    def __init__(self) -> None:
        super().__init__(storage_location="memory://")
        self._rows: dict[str, Ask] = {}

    def create(self, ask: Ask) -> Ask:
        from omnigent.errors import ErrorCode, OmnigentError

        if ask.elicitation_id is not None and self.get_by_elicitation(ask.elicitation_id):
            raise OmnigentError("duplicate elicitation", code=ErrorCode.ALREADY_EXISTS)
        self._rows[ask.id] = ask
        return ask

    def get(self, ask_id: str, *, user_id: str) -> Ask | None:
        row = self._rows.get(ask_id)
        return row if row is not None and row.user_id == user_id else None

    def get_by_elicitation(self, elicitation_id: str) -> Ask | None:
        for row in self._rows.values():
            if row.elicitation_id == elicitation_id:
                return row
        return None

    def list_open(self, *, user_id: str, limit: int = 50) -> list[Ask]:
        open_rows = [
            r for r in self._rows.values() if r.user_id == user_id and r.status is AskStatus.OPEN
        ]
        open_rows.sort(key=lambda r: (r.created_at, r.id), reverse=True)
        return open_rows[:limit]

    def set_status(
        self,
        ask_id: str,
        *,
        user_id: str,
        status: AskStatus,
        answer: str | None,
        answered_at: int | None,
    ) -> Ask | None:
        from dataclasses import replace

        row = self._rows.get(ask_id)
        if row is None or row.user_id != user_id:
            return None
        if row.status is AskStatus.OPEN:
            row = replace(row, status=status, answer=answer, answered_at=answered_at)
            self._rows[ask_id] = row
        return row

    def expire_open_for_session(self, session_id: str, *, now: int) -> list[Ask]:
        from dataclasses import replace

        expired = []
        for ask_id, row in list(self._rows.items()):
            if row.session_id == session_id and row.status is AskStatus.OPEN:
                updated = replace(row, status=AskStatus.EXPIRED, answered_at=now)
                self._rows[ask_id] = updated
                expired.append(updated)
        return expired
