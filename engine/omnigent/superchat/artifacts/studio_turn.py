"""What a file's studio turn starts with (ADR 0024), read on the runner.

The engine names the file (``GET /v1/artifacts/studio-turn``): its line, a deck's slide outline
(``decks/outline.py``), and the Conversation and group the write-back is scoped to. The
write-back then brings this file's hand edits into the workspace and words each once for this
studio. No Projects list, no recall hint and no
Conversation artifact hint: the studio is about one file.
"""

from __future__ import annotations

import logging

import httpx

from omnigent.superchat.artifacts.writeback import deliver_manual_edits

_logger = logging.getLogger(__name__)

#: How the file line opens (readers cut it from a stored message by it).
FILE_LINE_OPEN = "The file of this chat: "

#: Per studio session, the hand-edited versions its turns were already told about. A runner
#: restart forgets it, so a note may repeat once; the edit is never lost.
_NOTED: dict[str, set[str]] = {}


async def studio_turn_blocks(
    server_client: httpx.AsyncClient | None, session_id: str
) -> list[str]:
    """The file line, a deck's outline, then this file's write-back notes; ``[]`` when unknown."""
    if server_client is None or not session_id:
        return []
    try:
        resp = await server_client.get(
            f"/v1/artifacts/studio-turn?session_id={session_id}", timeout=10.0
        )
        studio = resp.json().get("studio") if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        _logger.warning("studio turn lookup failed", extra={"session_id": session_id})
        return []
    if not isinstance(studio, dict) or not isinstance(studio.get("file_line"), str):
        return []
    notes = await deliver_manual_edits(
        server_client,
        str(studio["conversation_id"]),
        group_id=str(studio["group_id"]),
        noted=_NOTED.setdefault(session_id, set()),
    )
    outline = studio.get("outline")
    return [
        studio["file_line"],
        *([outline] if isinstance(outline, str) and outline else []),
        *notes,
    ]
