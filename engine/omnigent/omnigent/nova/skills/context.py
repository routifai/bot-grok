"""Nova's skills contribution to a turn's context."""

from __future__ import annotations

import asyncio

from omnigent.nova import skills as _skills
from omnigent.nova._shared import ContextRequest, ContextSection, Scope, redact
from omnigent.nova.skills.service import render_skills_context

MAX_BYTES = 2 * 1024

_PRIORITY = 45


async def context_section(request: ContextRequest) -> ContextSection | None:
    """The person's saved skills and open offers, rendered for this turn.

    Private sessions only (rule 3 in ``nova/README.md``): a shared/project
    session never sees a person's skills. Lists open offers too, so Nova can
    see it already offered something this session and not repeat it — the
    database-level no-repeat guard in ``SkillService.offer`` is the actual
    enforcement; this is only a hint to the model.

    :param request: This turn's context request.
    :returns: A ``"skills"`` section, or ``None`` outside a private session
        or when the person has nothing saved or pending.
    """
    if request.scope is not Scope.PRIVATE:
        return None

    service = _skills._runtime_service()
    skills, offers = await asyncio.gather(
        asyncio.to_thread(service.list_skills, request.actor),
        asyncio.to_thread(service.open_offers, request.actor),
    )
    body = redact(render_skills_context(skills, offers, MAX_BYTES), request.secrets)
    if not body:
        return None
    return ContextSection(key="skills", body=body, priority=_PRIORITY, max_bytes=MAX_BYTES)
