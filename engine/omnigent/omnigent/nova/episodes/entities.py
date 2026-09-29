"""The episodes domain type."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Episode:
    """One short, dated record of a finished task Nova did for a person.

    :param id: 32-char hex row id.
    :param workspace_id: Tenant partition; ``0`` on single-workspace servers.
    :param user_id: The person this episode belongs to (never a bot).
    :param session_id: The session the turn ran in.
    :param turn_id: The turn's response id; recording is idempotent per
        ``(workspace_id, session_id, turn_id)``.
    :param title: Short title, from the person's request.
    :param summary: Plain-text summary, from Nova's reply.
    :param tools: Distinct tool names used, sorted.
    :param links: Distinct http(s) links mentioned in the reply, in order.
    :param created_at: Unix epoch seconds when the episode was first recorded.
    :param updated_at: Unix epoch seconds of the last re-recording of the same
        turn, or ``None`` if it has only ever been recorded once.
    """

    id: str
    workspace_id: int
    user_id: str
    session_id: str
    turn_id: str
    title: str
    summary: str
    tools: tuple[str, ...]
    links: tuple[str, ...]
    created_at: int
    updated_at: int | None = None
