"""The contract between primitives and the context composer."""

from __future__ import annotations

from dataclasses import dataclass, field

from omnigent.nova._shared.identity import NovaActor
from omnigent.nova._shared.scope import Scope


@dataclass(frozen=True)
class ContextRequest:
    """One turn's request for context.

    :param actor: The person the session belongs to (resolved by the server,
        never taken from the runner).
    :param scope: The session's privacy scope.
    :param session_id: The Omnigent session id.
    :param turn_input: The person's latest message, for relevance ranking.
    :param timezone: The person's IANA timezone, e.g. ``"America/Toronto"``.
    :param secrets: Values that must never appear in context (redacted).
    """

    actor: NovaActor
    scope: Scope
    session_id: str
    turn_input: str = ""
    timezone: str = "UTC"
    secrets: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ContextSection:
    """What one primitive contributes to a turn's context.

    :param key: Stable name, e.g. ``"memory"``; also the XML-ish tag the
        composer wraps the body in.
    :param body: The text itself, already rendered. Treated as data, not
        instructions, by the preamble the composer adds.
    :param priority: Lower comes first; sections are dropped from the end
        when the total budget runs out.
    :param max_bytes: This section's own UTF-8 budget.
    """

    key: str
    body: str
    priority: int = 50
    max_bytes: int = 8 * 1024
