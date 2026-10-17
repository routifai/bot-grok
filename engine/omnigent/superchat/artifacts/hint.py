"""The runtime hint naming this Conversation's artifacts, put at the start of every turn.

Pure: the artifact store's newest versions and the artifact open beside the chat in, a few lines
out (docs/conversation.md "Runtime hint"). No model call and no tool: the assistant reads which
artifact "it" most likely is before its first word.
"""

from __future__ import annotations

import logging
from collections.abc import Collection, Sequence

import httpx

from omnigent.superchat.artifact_kinds import is_deck_name
from omnigent.superchat.artifacts.store import Artifact

_logger = logging.getLogger(__name__)

HEADER = "Artifacts in this conversation (newest first):"
OPEN_MARK = " — open beside the chat"
#: A file whose studio (ADR 0024) has a turn running: the person is changing it there now.
EDITING_MARK = " — being edited in its studio"
#: Most artifacts the hint names; with the header it stays within ten lines.
MAX_ARTIFACTS = 8

_KIND_WORDS = {
    "html": "page",
    "md": "document",
    "docx": "document",
    "txt": "document",
    "pdf": "PDF",
    "xlsx": "sheet",
    "csv": "sheet",
    "pptx": "slides",
    "png": "image",
    "jpg": "image",
    "json": "data",
}


def kind_word(item: Artifact) -> str:
    """What the artifact is, in one word the person would use."""
    if is_deck_name(item.name):
        return "deck"
    return _KIND_WORDS.get(item.kind, item.kind)


def _line(item: Artifact, *, is_open: bool, editing: bool = False) -> str:
    label = " ".join((item.title or item.name).split())
    mark = (OPEN_MARK if is_open else "") + (EDITING_MARK if editing else "")
    return f"- {label} ({kind_word(item)}, v{item.version}, {item.id}){mark}"


def artifact_hint(
    newest: Sequence[Artifact],
    open_artifact: Artifact | None = None,
    editing: Collection[str] = (),
) -> str | None:
    """The hint block, or ``None`` when the Conversation has no artifacts.

    :param newest: The newest version of each artifact, newest first (as the store lists them).
    :param open_artifact: The newest version of the artifact open beside the chat, if any. It is
        marked where it stands, or named first when it is older than the ones listed.
    :param editing: Names of the files whose studio has a turn running (marked as being edited).
    :returns: The header and at most :data:`MAX_ARTIFACTS` lines.
    """
    items = list(newest)
    if open_artifact is not None:
        at = next((i for i, a in enumerate(items) if a.name == open_artifact.name), None)
        if at is None:
            items.insert(0, open_artifact)
        else:
            items[at] = open_artifact
    items = items[:MAX_ARTIFACTS]
    if not items:
        return None
    open_name = open_artifact.name if open_artifact is not None else None
    lines = [
        _line(item, is_open=item.name == open_name, editing=item.name in editing) for item in items
    ]
    return "\n".join([HEADER, *lines])


async def fetch_artifact_hint(
    server_client: httpx.AsyncClient | None, conversation_id: str
) -> list[str]:
    """The hint for this turn from the engine (``GET /v1/artifacts/hint``), as a prefix block.

    Runs on the runner at the start of every Super Chat turn; a Helper, a Conversation with no
    artifacts or any failure gives no block.
    """
    if server_client is None or not conversation_id:
        return []
    try:
        resp = await server_client.get(
            f"/v1/artifacts/hint?session_id={conversation_id}", timeout=10.0
        )
        hint = resp.json().get("hint") if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        _logger.warning("artifact hint fetch failed", extra={"session_id": conversation_id})
        return []
    return [hint] if isinstance(hint, str) and hint else []
