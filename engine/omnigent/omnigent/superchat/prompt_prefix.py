"""What a Super Chat turn or a new Helper's Brief is prefixed with: the one hook.

Both the runner's per-turn path (``runner/app.py``) and the sub-agent launch paths
(``runner/tool_dispatch.py``) read the person's Memory Profile from the server here, and the
runner's per-turn path also reads the local-time line. Failures never fail the turn: a missing
profile means "no profile".
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path

import httpx

from omnigent.memory.service import PROFILE_BLOCK_FOOTER, PROFILE_BLOCK_HEADER
from omnigent.superchat.artifacts.writeback import NOTE_LINE as EDIT_NOTE_LINE
from omnigent.superchat.knowledge.attachment_context import OPEN as ATTACHMENT_OPEN
from omnigent.superchat.knowledge.attachment_context import REMINDER as ATTACHMENT_REMINDER
from omnigent.superchat.local_time import LOCAL_TIME_OPEN, fetch_timezone, local_time_block
from omnigent.superchat.projects.block import PROJECTS_OPEN, projects_block
from omnigent.superchat.projects.choice import MOVED_NOTE
from omnigent.superchat.recall_hint.hint import FOOTER as HINT_FOOTER
from omnigent.superchat.recall_hint.hint import HEADER as HINT_HEADER
from omnigent.superchat.recall_hint.hint import recall_hint_block

_logger = logging.getLogger(__name__)

#: Sent in place of a block the warm client already holds, see :func:`turn_prefix_blocks`.
PROFILE_UNCHANGED_LINE = "Standing memory unchanged since the last message."
PROJECTS_UNCHANGED_LINE = "Projects unchanged since the last message."


IDLE_GAP_OPEN, IDLE_GAP_CLOSE = "It has been ", " since the last message."


def idle_gap_line(idle_seconds: float) -> str:
    """One plain line naming how long the person was away, e.g. ``It has been 3 days ...``."""
    hours = int(idle_seconds // 3600)
    days = hours // 24
    if days >= 2:
        span = f"{days} days"
    elif hours >= 1:
        span = f"{hours} hour" + ("" if hours == 1 else "s")
    else:
        span = "less than an hour"
    return f"{IDLE_GAP_OPEN}{span}{IDLE_GAP_CLOSE}"


def _delta_block(
    name: str,
    block: str,
    unchanged_line: str,
    last_sent: Mapping[str, str] | None,
    sent_now: dict[str, str] | None,
) -> str:
    """*block*, or *unchanged_line* when the warm client already got this exact block.

    Records the block's hash in *sent_now* either way: the client holds it after this turn.
    """
    digest = hashlib.sha256(block.encode("utf-8")).hexdigest()
    if sent_now is not None:
        sent_now[name] = digest
    if last_sent is not None and last_sent.get(name) == digest:
        return unchanged_line
    return block


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
    return local_time_block(await fetch_timezone(server_client))


def _safe_projects_block(workspace: Path | None) -> str | None:
    """The Project list block; a filesystem or parsing surprise means "no block"."""
    try:
        return projects_block(workspace)
    except Exception:  # noqa: BLE001 - the list is a convenience, never a reason to fail a turn
        _logger.warning("Project list failed; proceeding without it", exc_info=True)
        return None


async def _feature_prefix_blocks(
    server_client: httpx.AsyncClient | None, conversation_id: str
) -> list[str]:
    """Every feature's ``turn_prefix`` blocks, in feature order. Never fails a turn."""
    from omnigent.superchat.features import FEATURES

    blocks: list[str] = []
    for feature in FEATURES:
        if feature.turn_prefix is None:
            continue
        try:
            blocks.extend(await feature.turn_prefix(server_client, conversation_id))
        except Exception:  # noqa: BLE001 - a convenience, never a reason to fail a turn
            _logger.warning(
                "%s turn prefix failed; proceeding without it", feature.name, exc_info=True
            )
    return blocks


def message_needs_own_turn(texts: Sequence[str]) -> bool:
    """Whether any feature needs this message to start a turn of its own (``needs_own_turn``)."""
    from omnigent.superchat.features import FEATURES

    return any(
        feature.needs_own_turn(text)
        for feature in FEATURES
        if feature.needs_own_turn is not None
        for text in texts
    )


async def _message_prefix_blocks(
    server_client: httpx.AsyncClient | None, conversation_id: str, texts: Sequence[str]
) -> list[str]:
    """Every feature's ``message_prefix`` blocks for the turn's own message. Never fails a turn."""
    from omnigent.superchat.features import FEATURES

    blocks: list[str] = []
    for feature in FEATURES:
        if feature.message_prefix is None:
            continue
        try:
            blocks.extend(await feature.message_prefix(server_client, conversation_id, texts))
        except Exception:  # noqa: BLE001 - a convenience, never a reason to fail a turn
            _logger.warning(
                "%s message prefix failed; proceeding without it", feature.name, exc_info=True
            )
    return blocks


async def turn_prefix_blocks(
    server_client: httpx.AsyncClient | None,
    conversation_id: str,
    workspace: Path | None = None,
    message_texts: Sequence[str] = (),
    idle_gap_seconds: float | None = None,
    last_sent: Mapping[str, str] | None = None,
    sent_now: dict[str, str] | None = None,
    recall: bool = False,
) -> list[str]:
    """The blocks to prepend to a Super Chat turn, in application order.

    Each block is prepended in turn, so the last one ends up first: ``[message blocks (the files
    it attaches), recall hint (when any), memory profile (when any), Projects (when any), feature
    notes such as hand edits (when any), local time]`` renders as local time, then the feature
    notes, then the Projects, then the profile, then the recall hint, then the message blocks,
    then the person's message.

    :param workspace: The session's current working directory (marks the open Project).
    :param message_texts: Text parts of the turn's own message; features build blocks from them
        (``Feature.message_prefix``) that go first, so they end up closest to the message.
    :param idle_gap_seconds: How long the person was away, when this is the first message back
        from an idle break; adds one line next to the local time.
    :param last_sent: Hashes (by ``profile`` / ``projects``) of the blocks the current warm
        client last received. A block with the same hash goes as one short line instead.
        ``None`` (a cold start, or anything unproven) sends every block in full.
    :param sent_now: Filled with the hashes of the profile and Projects blocks this turn
        carries, for the caller to remember once the turn completes.
    :param recall: Whether this chat may get the recall hint (the owner's setting decides, see
        :mod:`omnigent.superchat.recall_hint`). It is built alongside the other fetches.
    """
    hint = (
        asyncio.create_task(
            recall_hint_block(server_client, conversation_id, workspace, message_texts)
        )
        if recall and message_texts
        else None
    )
    blocks: list[str] = []
    if message_texts:
        blocks.extend(await _message_prefix_blocks(server_client, conversation_id, message_texts))
    hint_at = len(blocks)
    profile = await fetch_memory_profile(server_client, conversation_id)
    if profile:
        blocks.append(
            _delta_block("profile", profile, PROFILE_UNCHANGED_LINE, last_sent, sent_now)
        )
    if (projects := _safe_projects_block(workspace)) is not None:
        blocks.append(
            _delta_block("projects", projects, PROJECTS_UNCHANGED_LINE, last_sent, sent_now)
        )
    blocks.extend(await _feature_prefix_blocks(server_client, conversation_id))
    if idle_gap_seconds is not None:
        blocks.append(idle_gap_line(idle_gap_seconds))
    blocks.append(await fetch_local_time_line(server_client))
    if hint is not None and (recalled := await hint):
        blocks.insert(hint_at, recalled)
    return blocks


#: The blocks that span lines, as (how one starts, what ends it). Projects end at the ``]`` that
#: closes the block, the one followed by the blank line before the next block.
_FENCED_BLOCKS = (
    (PROFILE_BLOCK_HEADER, PROFILE_BLOCK_FOOTER),
    (HINT_HEADER, "\n" + HINT_FOOTER),
    (ATTACHMENT_OPEN, ATTACHMENT_REMINDER),
    (PROJECTS_OPEN, "]\n\n"),
)
_MOVED_OPEN, _MOVED_CLOSE = MOVED_NOTE.split("{}")


def _injected_line(line: str) -> bool:
    """Whether *line* is one of the one-line blocks :func:`turn_prefix_blocks` writes."""
    line = line.strip()
    return (
        (line.startswith(LOCAL_TIME_OPEN) and line.endswith("]"))
        # The attachment block's closing line is left alone by the transcript's own cut of the
        # block (:func:`omnigent.context.attachments.strip_legacy_attachment_context`).
        or line in (PROFILE_UNCHANGED_LINE, PROJECTS_UNCHANGED_LINE, ATTACHMENT_REMINDER)
        or (line.startswith(IDLE_GAP_OPEN) and line.endswith(IDLE_GAP_CLOSE))
        or (line.startswith(_MOVED_OPEN) and line.endswith(_MOVED_CLOSE))
        or EDIT_NOTE_LINE.fullmatch(line) is not None
    )


def person_words(text: str) -> str:
    """*text* without the blocks :func:`turn_prefix_blocks` put in front of it: the person's words.

    The blocks go to the harness only, but a harness that keeps its own transcript can hand the
    prefixed message back, and a new Helper's Brief carries the Memory Profile. A reader that
    wants what the person said (the ``conversation`` index) cuts them here, by the markers their
    producers write. Only a leading run of blocks is cut, so the person's own text is never
    touched; a block that never ends was cut off with nothing after it, so nothing is left.
    """
    rest = text.lstrip()
    while rest:
        for opener, closer in _FENCED_BLOCKS:
            if rest.startswith(opener):
                end = rest.find(closer, len(opener))
                rest = "" if end < 0 else rest[end + len(closer) :].lstrip()
                break
        else:
            line, _, after = rest.partition("\n")
            if not _injected_line(line):
                return rest.rstrip()
            rest = after.lstrip()
    return ""
