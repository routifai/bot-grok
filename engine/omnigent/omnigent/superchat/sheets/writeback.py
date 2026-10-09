"""Hand edits -> the Computer workspace, plus the one-shot "you changed X" note.

Runs on the runner at the start of the Muse's turn (the runner sits next to the Computer's
files, so this works whenever a turn can run at all, including after the Computer was asleep
when the person saved). For every hand-edited version the server still lists as pending:

1. write the newest manual version's bytes to its ``source_path`` (idempotent: skipped when the
   file already holds exactly those bytes) so the Muse's next read sees the person's edits;
2. ack it (``POST /v1/artifacts/{id}/delivered``) so the note is shown once;
3. return one compact note per file for the turn prefix.

A failed write is not acked: the next turn retries, and the note says the file was not updated.
Reusable by any artifact kind (the HTML canvas editor will save ``origin="manual"`` versions the
same way).
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx

from omnigent.superchat.artifacts import workspace_roots

_logger = logging.getLogger(__name__)


def _safe_target(raw: str, roots: list[Path]) -> Path | None:
    """The real path for ``raw`` when it lies under a workspace root, else ``None``."""
    path = Path(raw).expanduser()
    if not path.is_absolute():
        return None
    try:
        real = path.parent.resolve() / path.name
        if real.is_symlink():
            real = real.resolve()
    except OSError:
        return None
    return real if any(real.is_relative_to(root) for root in roots) else None


def write_bytes_idempotent(target: Path, data: bytes) -> bool:
    """Atomically write ``data`` to ``target``; ``False`` when it already holds exactly that."""
    try:
        if target.is_file() and target.read_bytes() == data:
            return False
    except OSError:
        pass
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".nova-edit-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        if target.exists():
            os.chmod(tmp, target.stat().st_mode & 0o777)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return True


def _note(name: str, first: int, last: int, summaries: list[str], *, written: bool) -> str:
    detail = " ".join("; ".join(s for s in summaries if s).split())
    text = f"The person edited {name} by hand (v{first - 1} → v{last})"
    text += f": {detail}." if detail else "."
    text += f" Treat v{last} as current."
    if not written:
        text += " (Your workspace copy could not be updated yet; do not overwrite their edits.)"
    return text


async def deliver_manual_edits(
    server_client: httpx.AsyncClient | None,
    conversation_id: str,
    *,
    roots: list[Path] | None = None,
) -> list[str]:
    """Write pending hand edits back into the workspace; return the one-shot notes."""
    if server_client is None or not conversation_id:
        return []
    try:
        resp = await server_client.get(
            f"/v1/artifacts/pending-edits?parent_session_id={conversation_id}", timeout=10.0
        )
        if resp.status_code != 200:
            return []
        edits: list[dict[str, Any]] = resp.json().get("edits", [])
    except (httpx.HTTPError, ValueError):
        return []
    if not edits:
        return []
    allowed = roots if roots is not None else workspace_roots()
    groups: dict[str, list[dict[str, Any]]] = {}
    for edit in edits:
        groups.setdefault(edit["name"], []).append(edit)
    notes: list[str] = []
    for name, items in groups.items():
        items.sort(key=lambda e: e["version"])
        head = items[-1]
        written = True
        if head.get("write_back") and head.get("source_path"):
            try:
                content = await server_client.get(
                    f"/v1/artifacts/{head['id']}/content", timeout=60.0
                )
                content.raise_for_status()
                target = _safe_target(head["source_path"], allowed)
                if target is None:
                    written = False
                else:
                    await asyncio.to_thread(write_bytes_idempotent, target, content.content)
            except (httpx.HTTPError, OSError):
                _logger.warning(
                    "write-back of %s failed",
                    name,
                    exc_info=True,
                    extra={"session_id": conversation_id},
                )
                written = False
        elif head.get("write_back"):
            written = False  # no known workspace path (saved before paths were recorded)
        notes.append(
            _note(
                name,
                items[0]["version"],
                head["version"],
                [str(i.get("edit_summary") or "") for i in items],
                written=written,
            )
        )
        if written or not head.get("source_path"):
            for item in items:
                try:
                    await server_client.post(f"/v1/artifacts/{item['id']}/delivered", timeout=10.0)
                except httpx.HTTPError:
                    _logger.warning("could not ack edit %s", item["id"], exc_info=True)
    return notes
