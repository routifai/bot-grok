"""Nova's memory contribution to a turn's context."""

from __future__ import annotations

import asyncio

from omnigent.nova import memory as _memory
from omnigent.nova._shared import ContextRequest, ContextSection, Scope, redact
from omnigent.nova.memory.service import render_memory

# Matches loadAgentMemoryContext's MAX_AGENT_MEMORY_BYTES
# (packages/adapters/src/memory-context.ts).
MAX_BYTES = 32 * 1024

_PRIORITY = 20


async def context_section(request: ContextRequest) -> ContextSection | None:
    """The person's memory notes, rendered for this turn.

    Private sessions only (rule 3 in ``nova/README.md``): a shared/project
    session never sees a person's notes.

    :param request: This turn's context request.
    :returns: A ``"memory"`` section, or ``None`` outside a private session
        or when the person has nothing to remember yet.
    """
    if request.scope is not Scope.PRIVATE:
        return None

    notes = await asyncio.to_thread(_memory._runtime_store().list_notes, request.actor)
    rendered = render_memory(notes, MAX_BYTES)
    # Redacted here too, not just by context/composer.py's final pass, so this
    # primitive's contract — "never leaks a secret" — holds on its own.
    body = redact(rendered, request.secrets)
    if not body:
        return None
    return ContextSection(key="memory", body=body, priority=_PRIORITY, max_bytes=MAX_BYTES)
