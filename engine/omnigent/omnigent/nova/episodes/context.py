"""This primitive's contribution to a turn's context: recent relevant episodes."""

from __future__ import annotations

from omnigent.nova import episodes as _episodes
from omnigent.nova._shared import ContextRequest, ContextSection, Scope, cap_utf8, redact
from omnigent.nova.episodes.service import rank_episodes, render_episodes

# How many of the person's most recent episodes ranking considers.
_LOOKBACK_EPISODES = 300
_TOP_EPISODES = 3
_MAX_BYTES = 3 * 1024


async def context_section(request: ContextRequest) -> ContextSection | None:
    """The person's top 3 recent episodes relevant to this turn, if any.

    Private scope only: a shared/project session never sees a person's
    episodes.

    :param request: The turn's context request.
    :returns: A ``"past_episodes"`` section, or ``None`` when the scope is
        not private or nothing is relevant.
    """
    if request.scope is not Scope.PRIVATE:
        return None

    store = _episodes._runtime_store()
    episodes = store.list_recent(actor=request.actor, limit=_LOOKBACK_EPISODES)
    ranked = rank_episodes(request.turn_input, episodes, limit=_TOP_EPISODES)
    body = render_episodes(ranked, _MAX_BYTES)
    if not body:
        return None

    return ContextSection(
        key="past_episodes",
        body=cap_utf8(redact(body, request.secrets), _MAX_BYTES),
        priority=40,
        max_bytes=_MAX_BYTES,
    )
