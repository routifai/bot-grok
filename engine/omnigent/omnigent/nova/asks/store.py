"""Store interface for Asks.

Every method is scoped by ``workspace_id`` + ``user_id``: an Ask is always
private to the person it is for (README rule 3), regardless of which
session, tool, or bridge created it.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from omnigent.nova.asks.entities import Ask, AskStatus

# Asks are meant to be few and short-lived (README: "waiting on you"), but
# every list read must still be bounded (docs/DATABASE_BEST_PRACTICES.md).
MAX_OPEN_ASKS = 50


class AskStore(ABC):
    """Abstract base for Ask persistence."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI, e.g.
            ``"sqlite:///chat.db"``.
        """
        self.storage_location = storage_location

    @abstractmethod
    def create(self, ask: Ask) -> Ask:
        """Insert a new Ask.

        :param ask: The fully-formed Ask to persist (built by ``service.py``
            or ``bridge.py``, which mint the id and timestamps).
        :returns: The same Ask, echoed back for symmetry with other stores.
        :raises OmnigentError: ``ALREADY_EXISTS`` if ``ask.elicitation_id``
            is set and an Ask for that elicitation already exists in this
            workspace (see ``ix_nova_asks_elicitation``).
        """

    @abstractmethod
    def get(self, ask_id: str, *, user_id: str) -> Ask | None:
        """Return one of the person's Asks by id, or ``None`` if not found.

        :param ask_id: The Ask to fetch.
        :param user_id: The requesting person; an Ask owned by someone else
            is treated as not found.
        """

    @abstractmethod
    def get_by_elicitation(self, elicitation_id: str) -> Ask | None:
        """Return the Ask mirroring a given Omnigent elicitation, if any.

        Not user-scoped: the caller (``bridge.py``) already knows which
        session raised the elicitation and is checking for an existing
        mirror before creating a new one, not answering on the person's
        behalf.

        :param elicitation_id: The Omnigent elicitation correlation id.
        """

    @abstractmethod
    def list_open(self, *, user_id: str, limit: int = MAX_OPEN_ASKS) -> list[Ask]:
        """List the person's open Asks, newest first.

        :param user_id: The person whose Asks to return.
        :param limit: Bounds the scan; capped at :data:`MAX_OPEN_ASKS`.
        """

    @abstractmethod
    def set_status(
        self,
        ask_id: str,
        *,
        user_id: str,
        status: AskStatus,
        answer: str | None,
        answered_at: int | None,
    ) -> Ask | None:
        """Move an Ask out of ``open`` (answered or expired).

        A no-op (returns the unchanged row) if the Ask is not currently
        ``open`` — answering or expiring is idempotent, never a race with
        itself.

        :param ask_id: The Ask to update.
        :param user_id: The requesting person; an Ask owned by someone else
            is treated as not found.
        :param status: The new status (``ANSWERED`` or ``EXPIRED``).
        :param answer: The person's answer, for ``ANSWERED``; ``None`` for
            ``EXPIRED``.
        :param answered_at: When the transition happened.
        :returns: The updated Ask, or ``None`` if not found / not owned.
        """

    @abstractmethod
    def expire_open_for_session(self, session_id: str, *, now: int) -> list[Ask]:
        """Expire every open Ask tied to a session.

        Used when the thing an Ask was waiting on no longer applies — e.g.
        Goals closes the task an Ask blocked on before the person answered.

        :param session_id: The session whose open Asks should expire.
        :param now: Timestamp stamped as each Ask's ``answered_at``.
        :returns: The Asks that were expired (empty if none were open).
        """
