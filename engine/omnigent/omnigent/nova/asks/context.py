"""What the model should know about open Asks on each turn.

Keeps Nova from asking the same question twice in one session: a short list
of what is already waiting on the person, so the model checks here before
reaching for ``nova_ask_user`` again.
"""

from __future__ import annotations

import asyncio

from omnigent.nova import asks as _asks
from omnigent.nova._shared import ContextRequest, ContextSection, Scope, cap_utf8
from omnigent.nova.asks.entities import Ask

_KEY = "waiting_on_you"
_PRIORITY = 60
_MAX_BYTES = 1024
_MAX_LISTED = 5


async def context_section(request: ContextRequest) -> ContextSection | None:
    """The person's open Asks, so Nova doesn't ask the same thing twice.

    Private scope only (README rule 3): a project session never sees the
    owner's Asks, even ones raised from that same session.

    :param request: The turn's context request.
    :returns: A ``"waiting_on_you"`` section, or ``None`` when project-scoped
        or the person has nothing open.
    """
    if request.scope is not Scope.PRIVATE:
        return None
    asks = await asyncio.to_thread(_asks._runtime_service().list_open, request.actor)
    if not asks:
        return None
    body = "\n".join(f"- {_line(ask)}" for ask in asks[:_MAX_LISTED])
    return ContextSection(
        key=_KEY,
        body=cap_utf8(body, _MAX_BYTES),
        priority=_PRIORITY,
        max_bytes=_MAX_BYTES,
    )


def _line(ask: Ask) -> str:
    """Render one Ask as a single context line."""
    if ask.actions:
        options = " / ".join(action.label for action in ask.actions)
        return f"{ask.text} ({options})"
    return ask.text
