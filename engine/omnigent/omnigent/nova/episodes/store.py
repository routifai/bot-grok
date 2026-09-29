"""The episode store interface."""

from __future__ import annotations

from abc import ABC, abstractmethod

from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode


class EpisodeStore(ABC):
    """Persists episodes. Every method is scoped by the owning person.

    An episode belongs to ``(workspace_id, user_id)`` from :class:`NovaActor`;
    no method ever reads or writes another person's rows.
    """

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI, e.g.
            ``"sqlite:///chat.db"`` for SQLAlchemy.
        """
        self.storage_location = storage_location

    @abstractmethod
    def upsert(
        self,
        *,
        actor: NovaActor,
        session_id: str,
        turn_id: str,
        title: str,
        summary: str,
        tools: tuple[str, ...],
        links: tuple[str, ...],
        created_at: int,
    ) -> Episode:
        """
        Record a finished turn as an episode, idempotently.

        A second call with the same ``(actor.workspace_id, session_id,
        turn_id)`` updates the existing row's fields (and ``updated_at``)
        instead of inserting a duplicate, and keeps that row's original id.

        :param actor: The person the episode belongs to.
        :param session_id: The session the turn ran in.
        :param turn_id: The turn's response id.
        :param title: Short title, already built and length-capped.
        :param summary: Plain-text summary, already built and length-capped.
        :param tools: Distinct tool names used, sorted.
        :param links: Distinct http(s) links mentioned in the reply.
        :param created_at: Unix epoch seconds; stamped as ``created_at`` on
            first insert, ``updated_at`` on a later re-recording.
        :returns: The persisted :class:`Episode`.
        """
        ...

    @abstractmethod
    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        """
        Return the person's most recent episodes, newest first.

        :param actor: The person whose episodes to list.
        :param limit: Maximum number of episodes to return.
        :returns: Up to ``limit`` episodes, ordered by ``created_at`` then
            ``id`` descending.
        """
        ...

    @abstractmethod
    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:
        """
        Delete one of the person's episodes. Idempotent.

        :param episode_id: The episode to delete.
        :param actor: The requesting person; an episode owned by someone
            else is treated as not found.
        :returns: ``True`` if removed, ``False`` if not found / not owned.
        """
        ...
