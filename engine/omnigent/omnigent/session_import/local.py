"""Read and normalize local coding-harness transcripts."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from collections.abc import Sequence
from hashlib import sha256
from pathlib import Path
from typing import get_args

from omnigent.entities import NewConversationItem, parse_item_data
from omnigent.harnesses.claude_native.bridge import (
    ClaudeTranscriptItem,
    read_transcript_items_from_offset,
)
from omnigent.harnesses.codex_native.main import _CODEX_THREAD_ID_RE, _find_codex_rollout
from omnigent.session_import.models import (
    ImportSource,
    LocalSessionImport,
    SessionImportNotFoundError,
)

_PI_IMPORT_SESSION_ID_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
_MAX_EXTERNAL_SESSION_ID_LENGTH = 128
_MAX_RESPONSE_ID_LENGTH = 64

# Transcript byte size past which an import is trimmed to the last compaction
# boundary instead of the full history. Below it the whole transcript imports
# (cheap, and the full record is useful to browse); above it the file has almost
# certainly been compacted at least once, so importing every pre-compaction
# record replays megabytes the live agent no longer sees. Shared by the Claude
# (``isCompactSummary``) and Codex (``compacted`` record) paths — see
# docs/session-compaction.md.
_IMPORT_COMPACT_TRIM_BYTES = 2 * 1024 * 1024


def _exceeds_compaction_trim_size(path: Path) -> bool:
    """Whether a transcript is large enough to trim to its last compaction.

    An unreadable size falls back to ``False`` — import the whole transcript
    rather than drop history on a failed ``stat``.
    """
    try:
        return path.stat().st_size > _IMPORT_COMPACT_TRIM_BYTES
    except OSError:
        return False


def _bounded_response_id(response_id: str) -> str:
    """Keep short native ids readable and hash long ids without collisions."""
    if len(response_id) <= _MAX_RESPONSE_ID_LENGTH:
        return response_id
    harness, separator, _ = response_id.partition(":")
    prefix = f"{harness}:sha256:" if separator else "sha256:"
    digest_length = _MAX_RESPONSE_ID_LENGTH - len(prefix)
    return prefix + sha256(response_id.encode()).hexdigest()[:digest_length]


def _find_transcript(root: Path, session_id: str) -> Path | None:
    """Return the newest parent JSONL transcript whose stem matches the id."""
    matches = [
        path
        for path in root.rglob("*.jsonl")
        if path.stem == session_id and "subagents" not in path.parts and path.is_file()
    ]
    return max(matches, key=lambda path: path.stat().st_mtime) if matches else None


def _recent_unique_sessions_with_recency(
    candidates: list[tuple[Path, str]],
    *,
    limit: int,
) -> list[tuple[str, float]]:
    """Return ``(session_id, recency)`` pairs, newest transcript first.

    ``recency`` is the newest mtime seen for that id, kept so callers can merge
    sessions across harnesses by a single global recency order.
    """
    newest_by_id: dict[str, float] = {}
    for path, session_id in candidates:
        try:
            modified_at = path.stat().st_mtime
        except OSError:
            continue
        newest_by_id[session_id] = max(newest_by_id.get(session_id, 0), modified_at)
    ordered = sorted(
        newest_by_id,
        key=lambda session_id: (newest_by_id[session_id], session_id),
        reverse=True,
    )
    return [(session_id, newest_by_id[session_id]) for session_id in ordered[:limit]]


def _pi_session_id_from_path(path: Path) -> str | None:
    """Read a safe native session id from a Pi transcript header."""
    try:
        with path.open(encoding="utf-8") as handle:
            header = json.loads(handle.readline())
    except (OSError, ValueError):
        return None
    session_id = header.get("id") if isinstance(header, dict) else None
    if not isinstance(session_id, str) or not _is_safe_pi_import_session_id(session_id):
        return None
    return session_id


def _is_safe_pi_import_session_id(session_id: str) -> bool:
    """Match Pi's safe syntax within the import API's identity limit."""
    return (
        len(session_id) <= _MAX_EXTERNAL_SESSION_ID_LENGTH
        and _PI_IMPORT_SESSION_ID_RE.fullmatch(session_id) is not None
    )


# Codex records the session's origin in ``session_meta.source``. Its own resume
# picker lists only interactive sources (Cli, VSCode); ``exec`` runs, ``mcp``
# sessions, and sub-agent / internal threads are automation the user never
# opened interactively. Match that so recent-import doesn't flood the sidebar
# with headless ``codex exec`` runs, whose first message is an injected
# instruction, which is what produced the "many instruction-like titles" report.
_CODEX_INTERACTIVE_SOURCES = frozenset({"cli", "vscode"})


def _codex_rollout_source(path: Path) -> object | None:
    """Return a Codex rollout's recorded ``session_meta.source``, if present.

    ``session_meta`` is the first record in a rollout, so only the first line is
    read. Returns the raw value (a string like ``"cli"`` / ``"exec"`` for
    top-level sources, or a dict for sub-agent / internal ones), or ``None`` when
    the file is unreadable or predates the ``source`` field.
    """
    try:
        with path.open(encoding="utf-8") as handle:
            first = handle.readline()
    except OSError:
        return None
    try:
        record = json.loads(first)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("type") != "session_meta":
        return None
    payload = record.get("payload")
    return payload.get("source") if isinstance(payload, dict) else None


def _codex_source_is_interactive(source: object) -> bool:
    """Whether a Codex session source is one the interactive picker shows.

    Mirrors Codex's resume picker (interactive = ``Cli`` / ``VSCode``). A missing
    source (very old rollouts predating the field) defaults to interactive so
    genuine history isn't dropped; any recorded non-interactive value (``exec``,
    ``mcp``, or a sub-agent / internal object) is excluded.
    """
    if source is None:
        return True
    return isinstance(source, str) and source.lower() in _CODEX_INTERACTIVE_SOURCES


def _recent_local_sessions_with_recency(
    source: ImportSource,
    *,
    limit: int,
) -> list[tuple[str, float]]:
    """List recent ``(session_id, recency)`` pairs for one local harness, newest first."""
    if source == "claude":
        configured_home = os.environ.get("CLAUDE_CONFIG_DIR")
        home = Path(configured_home).expanduser() if configured_home else Path.home() / ".claude"
        root = home / "projects"
        candidates = [
            (path, path.stem)
            for path in root.rglob("*.jsonl")
            if "subagents" not in path.parts and path.is_file()
        ]
        return _recent_unique_sessions_with_recency(candidates, limit=limit)

    if source == "pi":
        configured_home = os.environ.get("PI_CODING_AGENT_DIR")
        home = (
            Path(configured_home).expanduser()
            if configured_home
            else Path.home() / ".pi" / "agent"
        )
        # Pi stores ids in the header, so discovery intentionally reads one line per file.
        candidates = [
            (path, session_id)
            for path in (home / "sessions").rglob("*.jsonl")
            if path.is_file() and (session_id := _pi_session_id_from_path(path)) is not None
        ]
        return _recent_unique_sessions_with_recency(candidates, limit=limit)

    if source == "codex":
        configured_home = os.environ.get("CODEX_HOME")
        home = Path(configured_home).expanduser() if configured_home else Path.home() / ".codex"
        rollouts: list[Path] = []
        sessions = home / "sessions"
        archived_sessions = home / "archived_sessions"
        if sessions.is_dir():
            rollouts.extend(path for path in sessions.glob("**/rollout-*.jsonl") if path.is_file())
        if archived_sessions.is_dir():
            rollouts.extend(
                path for path in archived_sessions.glob("rollout-*.jsonl") if path.is_file()
            )
        candidates = []
        for path in rollouts:
            session_id = path.stem[-36:]
            if not _CODEX_THREAD_ID_RE.fullmatch(session_id):
                continue
            # Read the rollout's source (one line) and skip non-interactive
            # runs (exec / mcp / sub-agent / internal) that Codex itself hides.
            if not _codex_source_is_interactive(_codex_rollout_source(path)):
                continue
            candidates.append((path, session_id))
        return _recent_unique_sessions_with_recency(candidates, limit=limit)

    raise ValueError(f"Unsupported import source: {source}")


def list_recent_local_session_ids(
    source: ImportSource,
    *,
    limit: int,
) -> tuple[str, ...]:
    """List recent parent session ids for one local harness, newest first."""
    return tuple(sid for sid, _ in _recent_local_sessions_with_recency(source, limit=limit))


def list_recent_sessions_across_harnesses(*, limit: int) -> list[tuple[ImportSource, str]]:
    """Return the ``limit`` most recent sessions across every harness, newest first.

    Unlike calling :func:`list_recent_local_session_ids` per harness (which would
    yield ``limit`` *each*), this merges all harnesses into one global recency
    order and keeps the top ``limit`` — so "last N" means N total. A harness with
    no history is skipped.
    """
    scored: list[tuple[float, ImportSource, str]] = []
    for source in get_args(ImportSource):
        try:
            recent = _recent_local_sessions_with_recency(source, limit=limit)
        except (SessionImportNotFoundError, OSError, ValueError, TypeError):
            continue
        scored.extend((recency, source, sid) for sid, recency in recent)
    scored.sort(key=lambda entry: (entry[0], entry[2]), reverse=True)
    return [(source, sid) for _, source, sid in scored[:limit]]


def _claude_workspace(transcript_path: Path) -> str | None:
    """Read the first usable cwd recorded in a Claude transcript."""
    with transcript_path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            cwd_value = record.get("cwd") if isinstance(record, dict) else None
            if isinstance(cwd_value, str):
                cwd = cwd_value.strip()
                if cwd:
                    return cwd
    return None


def _claude_native_title(transcript_path: Path) -> str | None:
    """Return Claude Code's own session title, custom name over AI-generated.

    Claude appends ``custom-title`` (user rename) and ``ai-title`` (generated)
    lines to the JSONL as they change; the last of each wins. A user's rename
    beats the AI title.
    """
    custom: str | None = None
    ai: str | None = None
    try:
        with transcript_path.open(encoding="utf-8") as handle:
            for line in handle:
                if "-title" not in line:  # cheap prefilter; the type is custom-title / ai-title
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") == "custom-title":
                    value = record.get("customTitle")
                    if isinstance(value, str) and value.strip():
                        custom = value.strip()
                elif record.get("type") == "ai-title":
                    value = record.get("aiTitle")
                    if isinstance(value, str) and value.strip():
                        ai = value.strip()
    except OSError:
        return None
    return custom or ai


def _items_from_last_compaction(
    items: Sequence[ClaudeTranscriptItem],
) -> Sequence[ClaudeTranscriptItem]:
    """Slice ``items`` from the last compaction summary onward.

    Claude flags the continuation summary it writes after compacting its own
    context with ``is_compact_summary`` — the durable compaction boundary (see
    :mod:`omnigent.harnesses.claude_native.bridge`). The live agent resumes from
    that summary, not the full transcript, so keeping the summary and everything
    after it mirrors the agent's working context. Returns ``items`` unchanged
    when the transcript was never compacted.
    """
    last = None
    for index, item in enumerate(items):
        if item.is_compact_summary:
            last = index
    return items if last is None else items[last:]


def _claude_import_item_data(item: ClaudeTranscriptItem) -> dict[str, object]:
    """Return an item's data, flagging a compaction summary as meta.

    Claude writes a continuation summary after compacting its own context; a
    large transcript is trimmed to start there, so the summary would otherwise
    become the sidebar title ("This session is being continued…"). It is durable
    context replayed to the agent, not a user turn; flag it ``is_meta`` so the
    title falls through to a real user message (matching Pi's branch summaries).
    """
    data = item.data
    if item.is_compact_summary and isinstance(data, dict) and not data.get("is_meta"):
        return {**data, "is_meta": True}
    return data


def load_claude_session(
    session_id: str,
    *,
    claude_home: Path | None = None,
) -> LocalSessionImport:
    """Load one Claude Code parent session from its local JSONL transcript."""
    configured_home = os.environ.get("CLAUDE_CONFIG_DIR")
    home = claude_home or (Path(configured_home).expanduser() if configured_home else None)
    root = (home or Path.home() / ".claude") / "projects"
    transcript_path = _find_transcript(root, session_id)
    if transcript_path is None:
        raise SessionImportNotFoundError(f"Claude Code session {session_id!r} was not found")

    parsed = read_transcript_items_from_offset(
        transcript_path,
        0,
        start_line=0,
        agent_name="claude-native-ui",
    )
    # A large transcript has almost certainly compacted; import only what the
    # agent would still see (from the last compaction boundary). See
    # docs/session-compaction.md.
    source_items: Sequence[ClaudeTranscriptItem] = parsed.items
    if _exceeds_compaction_trim_size(transcript_path):
        source_items = _items_from_last_compaction(parsed.items)
    items = tuple(
        NewConversationItem(
            type=item.item_type,
            response_id=item.response_id,
            data=parse_item_data(item.item_type, _claude_import_item_data(item)),
        )
        for item in source_items
    )
    if not items:
        raise SessionImportNotFoundError(
            f"Claude Code session {session_id!r} has no importable history"
        )
    return LocalSessionImport(
        source="claude",
        external_session_id=session_id,
        workspace=_claude_workspace(transcript_path),
        items=items,
        native_title=_claude_native_title(transcript_path),
    )


def _codex_message_data(payload: dict[str, object]) -> dict[str, object] | None:
    """Convert a visible Codex message payload to Omnigent message data."""
    role = payload.get("role")
    if role not in {"user", "assistant"}:
        return None
    expected_type = "input_text" if role == "user" else "output_text"
    raw_content = payload.get("content")
    if not isinstance(raw_content, list):
        return None
    content: list[dict[str, object]] = []
    for block in raw_content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str) and text:
            content.append({"type": expected_type, "text": text})
        elif role == "user" and block.get("type") in {"input_image", "input_file"}:
            content.append(dict(block))
    if not content:
        return None
    data: dict[str, object] = {"role": role, "content": content}
    if role == "assistant":
        data["agent"] = "codex-native-ui"
    elif _codex_internal_user_message(content):
        data["is_meta"] = True
    return data


_CODEX_INTERNAL_USER_PREFIXES = (
    "# AGENTS.md instructions for ",
    "<app-context>",
    "<collaboration_mode>",
    "<environment_context>",
    "<permissions instructions>",
    "<plugins_instructions>",
    "<skill>",
    "<skills_instructions>",
    "The following is the Codex agent history ",
    "The following is the Codex agent history added ",
)


def _codex_internal_user_message(content: list[dict[str, object]]) -> bool:
    """Identify Codex-injected user-role context that should stay hidden."""
    text = next(
        (block.get("text") for block in content if isinstance(block.get("text"), str)),
        None,
    )
    return isinstance(text, str) and text.lstrip().startswith(_CODEX_INTERNAL_USER_PREFIXES)


def _codex_tool_output(value: object) -> str | None:
    """Flatten Codex string or typed-text-block tool output."""
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return None
    text_blocks = [
        block["text"]
        for block in value
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]
    return "".join(text_blocks) if text_blocks else None


def _codex_response_item(
    payload: dict[str, object],
    *,
    response_id: str,
) -> NewConversationItem | None:
    """Convert one supported Codex response item to an Omnigent item."""
    item_type = payload.get("type")
    normalized_type = item_type
    data: dict[str, object] | None = None
    if item_type == "message":
        data = _codex_message_data(payload)
    elif item_type in {"function_call", "custom_tool_call"}:
        name = payload.get("name")
        arguments = payload.get("arguments" if item_type == "function_call" else "input")
        call_id = payload.get("call_id")
        if all(isinstance(value, str) for value in (name, arguments, call_id)):
            data = {
                "agent": "codex-native-ui",
                "name": name,
                "arguments": arguments,
                "call_id": call_id,
            }
            normalized_type = "function_call"
    elif item_type in {"function_call_output", "custom_tool_call_output"}:
        call_id = payload.get("call_id")
        output = _codex_tool_output(payload.get("output"))
        if isinstance(call_id, str) and output is not None:
            data = {"call_id": call_id, "output": output}
            normalized_type = "function_call_output"
    if data is None or not isinstance(normalized_type, str):
        return None
    return NewConversationItem(
        type=normalized_type,
        response_id=response_id[:64],
        data=parse_item_data(normalized_type, data),
    )


def _find_archived_codex_rollout(codex_home: Path, session_id: str) -> Path | None:
    """Return the newest archived Codex rollout matching a session id."""
    archived_sessions = codex_home / "archived_sessions"
    if not archived_sessions.is_dir():
        return None
    suffix = f"-{session_id}.jsonl"
    matches = [
        path
        for path in archived_sessions.glob("rollout-*.jsonl")
        if path.name.endswith(suffix) and path.is_file()
    ]
    return max(matches, key=lambda path: path.stat().st_mtime) if matches else None


def _codex_thread_name_from_index(home: Path, session_id: str) -> str | None:
    """Return the user's thread rename from ``session_index.jsonl``, if any.

    Renaming a Codex thread appends ``{id, thread_name, updated_at}`` here; it
    is codex's authoritative rename store and, unlike ``threads.title`` in the
    state DB, always reflects the rename. Last entry for the id wins.
    """
    index = home / "session_index.jsonl"
    name: str | None = None
    try:
        with index.open(encoding="utf-8") as handle:
            for line in handle:
                if session_id not in line:  # cheap prefilter before JSON parse
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict) and record.get("id") == session_id:
                    value = record.get("thread_name")
                    if isinstance(value, str) and value.strip():
                        name = value.strip()
    except OSError:
        return None
    return name


def _codex_native_title(home: Path, session_id: str) -> str | None:
    """Return the user's custom Codex thread title, or None if auto-derived.

    A rename lands in ``session_index.jsonl`` (``thread_name``) — the reliable
    source — so check that first. As a fallback, ``state_<n>.sqlite``'s
    ``threads.title`` holds the raw first user message until renamed, so only a
    title that diverges from ``first_user_message`` is a real custom name;
    otherwise the first-message synthesis is better.
    """
    indexed = _codex_thread_name_from_index(home, session_id)
    if indexed:
        return indexed

    def _state_db_version(path: Path) -> int:
        match = re.search(r"state_(\d+)\.sqlite$", path.name)
        return int(match.group(1)) if match else -1

    dbs = sorted(home.glob("state_*.sqlite"), key=_state_db_version, reverse=True)
    for db in dbs:
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                row = con.execute(
                    "SELECT title, first_user_message FROM threads WHERE id = ?",
                    (session_id,),
                ).fetchone()
            finally:
                con.close()
        except sqlite3.Error:
            continue
        if row is None:
            continue
        title = (row[0] or "").strip()
        first_message = (row[1] or "").strip()
        return title if title and title != first_message else None
    return None


def _codex_compacted_baseline_items(payload: dict[str, object]) -> list[NewConversationItem]:
    """Convert a Codex ``compacted`` record's replacement_history into items.

    Codex appends ``{type: "compacted", payload: {replacement_history: [...]}}``
    after compacting; ``replacement_history`` is the post-compaction context
    baseline it resumes from (the summary plus any retained messages), each entry
    response-item shaped. Unsupported entries (e.g. reasoning) parse to ``None``
    and are skipped, mirroring the ordinary response-item path.
    """
    history = payload.get("replacement_history")
    if not isinstance(history, list):
        return []
    baseline: list[NewConversationItem] = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        item = _codex_response_item(entry, response_id="codex:compaction")
        if item is not None:
            baseline.append(item)
    return baseline


def load_codex_session(
    session_id: str,
    *,
    codex_home: Path | None = None,
) -> LocalSessionImport:
    """Load one Codex session from its local rollout JSONL file."""
    configured_home = os.environ.get("CODEX_HOME")
    home = codex_home or (Path(configured_home).expanduser() if configured_home else None)
    home = home or Path.home() / ".codex"
    rollout_path = _find_codex_rollout(home, session_id) or _find_archived_codex_rollout(
        home, session_id
    )
    if rollout_path is None:
        raise SessionImportNotFoundError(f"Codex session {session_id!r} was not found")

    # Past the size threshold, restart from each compaction boundary so the
    # import matches what the agent resumes with, dropping the pre-compaction
    # records it no longer sees. See docs/session-compaction.md.
    trim_at_compaction = _exceeds_compaction_trim_size(rollout_path)

    workspace: str | None = None
    turn_id = "history"
    items: list[NewConversationItem] = []
    with rollout_path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
                continue
            payload = record["payload"]
            if record.get("type") == "session_meta":
                cwd = payload.get("cwd")
                if isinstance(cwd, str) and cwd.strip():
                    workspace = cwd.strip()
                continue
            if record.get("type") == "turn_context":
                candidate = payload.get("turn_id")
                if isinstance(candidate, str) and candidate:
                    turn_id = candidate
                continue
            if record.get("type") == "compacted":
                # replacement_history is the new context baseline; resetting to it
                # discards prior items so only the last compaction's baseline and
                # what follows survive (mirrors the terminal agent on resume). A
                # boundary with no usable baseline is ignored rather than wiping
                # history to nothing (matches _read_compacted_history's guard).
                if trim_at_compaction:
                    baseline = _codex_compacted_baseline_items(payload)
                    if baseline:
                        items = baseline
                continue
            if record.get("type") != "response_item":
                continue
            item = _codex_response_item(payload, response_id=f"codex:{turn_id}")
            if item is not None:
                items.append(item)

    if not items:
        raise SessionImportNotFoundError(f"Codex session {session_id!r} has no importable history")
    return LocalSessionImport(
        source="codex",
        external_session_id=session_id,
        workspace=workspace,
        items=tuple(items),
        native_title=_codex_native_title(home, session_id),
    )


def _pi_text(content: object) -> str:
    """Flatten Pi string or typed-text content."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def _pi_message_content(content: object, *, role: str) -> list[dict[str, object]]:
    """Map Pi text and user-image blocks without changing their order."""
    content_type = "input_text" if role == "user" else "output_text"
    if isinstance(content, str):
        return [{"type": content_type, "text": content}] if content else []
    if not isinstance(content, list):
        return []
    normalized: list[dict[str, object]] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if block.get("type") == "text" and isinstance(text, str) and text:
            normalized.append({"type": content_type, "text": text})
            continue
        data = block.get("data")
        mime_type = block.get("mimeType")
        if (
            role == "user"
            and block.get("type") == "image"
            and isinstance(data, str)
            and data
            and isinstance(mime_type, str)
            and mime_type.startswith("image/")
        ):
            normalized.append(
                {"type": "input_image", "image_url": f"data:{mime_type};base64,{data}"}
            )
    return normalized


def _pi_active_branch(records: list[dict[str, object]]) -> list[dict[str, object]]:
    """Return Pi entries on the current leaf's root-to-leaf path."""
    header = next((record for record in records if record.get("type") == "session"), {})
    version = header.get("version")
    if not isinstance(version, int) or version < 2:
        legacy_parent_id: str | None = None
        migrated: list[dict[str, object]] = []
        for index, record in enumerate(records):
            if record.get("type") == "session":
                migrated.append(record)
                continue
            entry = dict(record)
            legacy_entry_id = f"legacy-{index}"
            entry["id"] = legacy_entry_id
            entry["parentId"] = legacy_parent_id
            migrated.append(entry)
            legacy_parent_id = legacy_entry_id
        records = migrated
    entries = [
        record
        for record in records
        if record.get("type") != "session" and isinstance(record.get("id"), str)
    ]
    if not entries:
        return []
    if all("parentId" not in entry for entry in entries):
        return entries
    by_id = {entry["id"]: entry for entry in entries}
    if len(by_id) != len(entries):
        return []
    branch: list[dict[str, object]] = []
    current = entries[-1]
    seen: set[str] = set()
    while True:
        entry_id = current["id"]
        if not isinstance(entry_id, str) or entry_id in seen:
            return []
        seen.add(entry_id)
        branch.append(current)
        parent_id = current.get("parentId")
        if parent_id is None:
            branch.reverse()
            return branch
        if not isinstance(parent_id, str) or parent_id not in by_id:
            return []
        current = by_id[parent_id]


def _pi_message_items(record: dict[str, object]) -> tuple[NewConversationItem, ...]:
    """Convert one Pi message entry to visible Omnigent items."""
    if record.get("type") == "branch_summary":
        summary = record.get("summary")
        if not isinstance(summary, str) or not summary:
            return ()
        entry_id = record.get("id")
        response_id = f"pi:{entry_id}" if isinstance(entry_id, str) else "pi:history"
        return (
            NewConversationItem(
                type="message",
                response_id=_bounded_response_id(response_id),
                data=parse_item_data(
                    "message",
                    {
                        "role": "user",
                        "is_meta": True,
                        "content": [
                            {
                                "type": "input_text",
                                "text": (
                                    "The following is a summary of a branch that this "
                                    "conversation came back from:\n\n<summary>\n"
                                    f"{summary}\n</summary>"
                                ),
                            }
                        ],
                    },
                ),
            ),
        )
    message = record.get("message")
    if record.get("type") != "message" or not isinstance(message, dict):
        return ()
    entry_id = record.get("id")
    response_id = f"pi:{entry_id}" if isinstance(entry_id, str) else "pi:history"
    role = message.get("role")
    if role == "toolResult":
        call_id = message.get("toolCallId")
        if not isinstance(call_id, str) or not call_id:
            return ()
        return (
            NewConversationItem(
                type="function_call_output",
                response_id=_bounded_response_id(response_id),
                data=parse_item_data(
                    "function_call_output",
                    {"call_id": call_id, "output": _pi_text(message.get("content"))},
                ),
            ),
        )
    if role not in {"user", "assistant"}:
        return ()

    items: list[NewConversationItem] = []
    content = message.get("content")
    if role == "user":
        normalized = _pi_message_content(content, role=role)
        if not normalized:
            return ()
        items.append(
            NewConversationItem(
                type="message",
                response_id=_bounded_response_id(response_id),
                data=parse_item_data(
                    "message",
                    {"role": "user", "content": normalized},
                ),
            )
        )
        return tuple(items)

    interrupted = message.get("stopReason") == "aborted"

    def append_assistant_text(blocks: list[dict[str, object]]) -> None:
        if not blocks:
            return
        data: dict[str, object] = {
            "role": "assistant",
            "agent": "pi-native-ui",
            "content": blocks,
        }
        if interrupted:
            data["interrupted"] = True
        items.append(
            NewConversationItem(
                type="message",
                response_id=_bounded_response_id(response_id),
                data=parse_item_data("message", data),
            )
        )

    if isinstance(content, str):
        append_assistant_text(_pi_message_content(content, role="assistant"))
    elif isinstance(content, list):
        pending_text: list[dict[str, object]] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                pending_text.extend(_pi_message_content([block], role="assistant"))
                continue
            if block.get("type") != "toolCall":
                continue
            append_assistant_text(pending_text)
            pending_text = []
            call_id = block.get("id")
            name = block.get("name")
            if (
                not isinstance(call_id, str)
                or not call_id
                or not isinstance(name, str)
                or not name
            ):
                continue
            arguments = block.get("arguments")
            serialized_arguments = (
                arguments
                if isinstance(arguments, str)
                else json.dumps(arguments if arguments is not None else {}, separators=(",", ":"))
            )
            # Only message items support interrupted state; retain aborted-turn tool calls.
            items.append(
                NewConversationItem(
                    type="function_call",
                    response_id=_bounded_response_id(response_id),
                    data=parse_item_data(
                        "function_call",
                        {
                            "agent": "pi-native-ui",
                            "name": name,
                            "arguments": serialized_arguments,
                            "call_id": call_id,
                        },
                    ),
                )
            )
        append_assistant_text(pending_text)
    return tuple(items)


def load_pi_session(
    session_id: str,
    *,
    pi_home: Path | None = None,
) -> LocalSessionImport:
    """Load the active branch of one Pi coding-agent JSONL session."""
    configured_home = os.environ.get("PI_CODING_AGENT_DIR")
    home = pi_home or (Path(configured_home).expanduser() if configured_home else None)
    root = (home or Path.home() / ".pi" / "agent") / "sessions"
    if not _is_safe_pi_import_session_id(session_id):
        raise SessionImportNotFoundError(f"Pi session {session_id!r} was not found")
    matches = [
        path
        for path in root.rglob("*.jsonl")
        if path.is_file() and _pi_session_id_from_path(path) == session_id
    ]
    if not matches:
        raise SessionImportNotFoundError(f"Pi session {session_id!r} was not found")
    if len(matches) > 1:
        raise SessionImportNotFoundError(f"Pi session {session_id!r} is ambiguous across projects")
    transcript_path = matches[0]
    records: list[dict[str, object]] = []
    with transcript_path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(record, dict):
                records.append(record)
    header = next((record for record in records if record.get("type") == "session"), {})
    if header.get("id") != session_id:
        raise SessionImportNotFoundError(
            f"Pi session {session_id!r} has mismatched transcript metadata"
        )
    workspace_value = header.get("cwd")
    workspace = workspace_value.strip() if isinstance(workspace_value, str) else None
    items = tuple(
        item for record in _pi_active_branch(records) for item in _pi_message_items(record)
    )
    if not items:
        raise SessionImportNotFoundError(f"Pi session {session_id!r} has no importable history")
    return LocalSessionImport(
        source="pi",
        external_session_id=session_id,
        workspace=workspace or None,
        items=items,
    )


def load_local_session(source: ImportSource, session_id: str) -> LocalSessionImport:
    """Load one local session from the selected first-party harness."""
    if source == "claude":
        return load_claude_session(session_id)
    if source == "codex":
        return load_codex_session(session_id)
    if source == "pi":
        return load_pi_session(session_id)
    raise ValueError(f"Unsupported import source: {source}")


__all__ = [
    "list_recent_local_session_ids",
    "load_claude_session",
    "load_codex_session",
    "load_local_session",
    "load_pi_session",
]
