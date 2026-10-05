"""What a Super Chat turn or a new Helper's Brief is prefixed with: the one hook.

Both the runner's per-turn path (``runner/app.py``) and the sub-agent launch paths
(``runner/tool_dispatch.py``) read the person's Memory Profile from the server here, and the
runner's per-turn path also reads the local-time line. Failures never fail the turn: a missing
profile means "no profile".
"""

from __future__ import annotations

import logging

import httpx

from omnigent.superchat.local_time import local_time_block

_logger = logging.getLogger(__name__)


async def fetch_memory_profile(
    server_client: httpx.AsyncClient | None, conversation_id: str | None
) -> str | None:
    """The chat owner's delimiter-wrapped Memory Profile block, or ``None``.

    Read from the server (``GET /v1/sessions/{id}/memory/profile``): the memory store lives
    server-side. Any failure, or an empty profile, means "no profile".
    """
    if server_client is None or not conversation_id:
        return None
    try:
        resp = await server_client.get(
            f"/v1/sessions/{conversation_id}/memory/profile", timeout=10.0
        )
        if resp.status_code != 200:
            _logger.warning(
                "Memory Profile fetch failed for %s; proceeding without it: status=%s",
                conversation_id,
                resp.status_code,
                extra={"session_id": conversation_id},
            )
            profile = None
        else:
            profile = resp.json().get("profile")
    except (httpx.HTTPError, ValueError) as exc:
        _logger.warning(
            "Memory Profile fetch failed for %s; proceeding without it: %s",
            conversation_id,
            type(exc).__name__,
            extra={"session_id": conversation_id},
        )
        return None
    return profile if isinstance(profile, str) and profile else None


async def fetch_local_time_line(server_client: httpx.AsyncClient | None) -> str:
    """The person's current local date/time line (owner preference zone; UTC when unknown)."""
    timezone: str | None = None
    try:
        if server_client is not None:
            resp = await server_client.get("/v1/me/proactivity", timeout=10.0)
            if resp.status_code == 200:
                timezone = resp.json().get("timezone")
    except (httpx.HTTPError, ValueError, AttributeError):
        pass
    return local_time_block(timezone)


async def turn_prefix_blocks(
    server_client: httpx.AsyncClient | None, conversation_id: str
) -> list[str]:
    """The blocks to prepend to a Super Chat turn, in application order.

    Each block is prepended in turn, so the last one ends up first: ``[memory profile (when
    any), local time]`` renders as local time, then the profile, then the person's message.
    """
    blocks: list[str] = []
    profile = await fetch_memory_profile(server_client, conversation_id)
    if profile:
        blocks.append(profile)
    blocks.append(await fetch_local_time_line(server_client))
    return blocks
