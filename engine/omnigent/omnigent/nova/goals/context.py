"""``<goals_active>`` context section: the person's Goals, or, inside a Goal's
own session, that one Goal in full.

Private-scope only (see ``omnigent.nova._shared.Scope``) — a shared project
session has no business seeing anyone's Goals. A session labelled
``nova.goal=<goal_id>`` (see ``service.GOAL_SESSION_LABEL_KEY`` and
``entities.Goal.session_id``) is that Goal's own background session, so it
gets single-goal mode: only that Goal, rendered in full, instead of the whole
list.

Uses ``omnigent.nova.goals._runtime_store()`` the same way ``tools.py``
does — see that module's docstring for why ``context.py`` can't take a
``NovaDeps``.
"""

from __future__ import annotations

import asyncio

from omnigent.nova import goals as _goals
from omnigent.nova._shared import ContextRequest, ContextSection, Scope, cap_utf8, redact
from omnigent.nova.goals import service
from omnigent.nova.goals.entities import GoalStatus
from omnigent.nova.goals.service import GOAL_SESSION_LABEL_KEY

_KEY = "goals_active"
_PRIORITY = 30
_MAX_BYTES = 8 * 1024
# GoalStore.list() has no includeClosed filter — it returns every Goal
# regardless of status — so a context section (which should only ever show
# Goals still in play, matching goals-context.ts) filters client-side.
_OPEN_STATUSES = (GoalStatus.ACTIVE, GoalStatus.PAUSED)


async def _focus_goal_id(session_id: str) -> str | None:
    """The Goal this session is dedicated to, if its labels say so."""
    from omnigent.runtime import get_conversation_store

    conversation = await asyncio.to_thread(get_conversation_store().get_conversation, session_id)
    if conversation is None:
        return None
    return conversation.labels.get(GOAL_SESSION_LABEL_KEY)


async def context_section(request: ContextRequest) -> ContextSection | None:
    """Build the ``goals_active`` section for one turn, or ``None``.

    :param request: The turn's context request.
    :returns: A :class:`ContextSection`, or ``None`` when the scope is not
        private or the person has no Goals to show.
    """
    if request.scope != Scope.PRIVATE:
        return None

    focus_goal_id = await _focus_goal_id(request.session_id)
    goals = await asyncio.to_thread(_goals._runtime_store().list, user_id=request.actor.user_id)
    if not focus_goal_id:
        # Single-goal focus mode shows that Goal regardless of status (it's
        # the person's own session for exactly this Goal); the general list
        # only ever surfaces Goals still in play.
        goals = [g for g in goals if g.status in _OPEN_STATUSES]
    if not goals:
        return None

    body = service.render_goals(goals, _MAX_BYTES, focus_goal_id=focus_goal_id)
    if not body:
        return None
    body = cap_utf8(redact(body, request.secrets), _MAX_BYTES)
    return ContextSection(key=_KEY, body=body, priority=_PRIORITY, max_bytes=_MAX_BYTES)
