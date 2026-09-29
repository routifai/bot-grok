"""In-process replacement for Nova's old HTTP context-provider endpoint.

The maintainer wires this into ``omnigent/runtime/context_provider.py``; this
module only builds the :class:`ContextRequest` and calls :func:`compose`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping

from omnigent.nova._shared import ContextRequest, NovaActor, scope_from_labels
from omnigent.nova.context.composer import compose

_logger = logging.getLogger(__name__)


async def provide(
    owner_user_id: str | None,
    labels: Mapping[str, str],
    turn_input: str,
    session_id: str,
    workspace_id: int = 0,
) -> str:
    """Build one turn's context for the session owner.

    :param owner_user_id: The session's resolved owner, or ``None`` for an
        unauthenticated/unowned session.
    :param labels: The session's conversation labels (``nova.scope`` and any
        others a primitive's scope check reads).
    :param turn_input: The person's latest message, for relevance ranking.
    :param session_id: The Omnigent session id.
    :param workspace_id: The Omnigent workspace id; ``0`` on single-workspace
        servers.
    :returns: The composed context, or ``""`` when there is no owner.
    """
    if owner_user_id is None:
        return ""
    actor = NovaActor(user_id=owner_user_id, workspace_id=workspace_id)
    request = ContextRequest(
        actor=actor,
        scope=scope_from_labels(labels),
        session_id=session_id,
        turn_input=turn_input,
        timezone=_resolve_timezone(actor),
    )
    return await compose(request)


def _resolve_timezone(actor: NovaActor) -> str:
    """Look up the person's timezone via ``omnigent.nova.memory.get_profile``.

    Imported lazily (not at module level) so ``context/`` still works if
    ``memory/`` is ever absent, and so this module never has to care whether
    memory has landed yet. Tolerant of any lookup failure — a timezone lookup
    must never break a turn's context.

    :param actor: Whose profile to read.
    :returns: An IANA timezone name, or ``"UTC"`` when unknown/unavailable.
    """
    try:
        from omnigent.nova import memory
    except ModuleNotFoundError:
        return "UTC"

    get_profile = getattr(memory, "get_profile", None)
    if get_profile is None:
        return "UTC"

    try:
        return get_profile(actor).timezone or "UTC"
    except Exception as exc:  # noqa: BLE001 — a timezone lookup must never break a turn
        _logger.warning("memory.get_profile failed; defaulting to UTC: %s", exc)
        return "UTC"
