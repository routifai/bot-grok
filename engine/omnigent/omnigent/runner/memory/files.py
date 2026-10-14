"""Journal and state files under ``~/workspace/memory/``, written by code and read by nobody here.

Layout::

    memory/STATE.md                  the Conversation's working list, one note line on top
    memory/journal/YYYY-MM-DD.md     "# <date>", a "## Journal" heading, then one line per event

A journal line is ``- <date> · <text> · <origin> <!-- <chat id> -->``. The origin says where it
came from: ``main``, ``side "<title>"`` or ``fork @ "<title>"``. Lines are appended under the
heading and never edited. The day file also holds two sections written by code from the day's
note: ``## Notes`` and ``## Reflection``, each replaced as a whole and never touching the Journal.
Appends run under a lock (a thread lock and, where the platform has
it, an ``flock`` on ``journal/.lock``), so two checkpoints that finish together keep both lines.
The date is the one the line carries, else today in UTC (the runner does not know the owner's
timezone).

The folder is a projection. The compaction items stored with the chats are the only source:
:mod:`omnigent.runner.memory.sync` regenerates the files from them, and **nothing in the engine
reads these files back** as state, summary or claim. Only the file indexer reads them, so a
passage can be found by search like any other file. A write that fails is logged and swallowed;
it must never fail or delay a turn.

No HTTP and no model call here.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import shutil
import tempfile
import threading
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from omnigent.context.rollover import _strip_seed_header
from omnigent.entities.daily_note import SECTION_TITLES, WRITER_KEYS
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.superchat.lineage import fork_anchor_id

try:  # POSIX only; elsewhere the thread lock alone guards a single runner process
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

_logger = logging.getLogger(__name__)

MEMORY_DIR = "memory"
JOURNAL_DIR = "journal"
STATE_FILE = "STATE.md"
JOURNAL_HEADING = "## Journal"
NOTES_HEADING = "## Notes"
REFLECTION_HEADING = "## Reflection"
#: The main Conversation's session id, written inside ``memory/`` (the folder belongs to it).
OWNER_FILE = ".owner"
#: The id of the last reset item written to the journal and ``STATE.md``.
LAST_RESET_FILE = ".last_reset"
RESET_TEXT = "conversation reset"
STATE_NOTE = "This is a copy of the working list, for reading. Edits here change nothing."
EVICTED_PREFIX = "Moved out of the working list: "
#: Longest chat title kept in an origin.
TITLE_MAX_CHARS = 80

_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:\s*[·|:-]\s*|\s+)")
_BULLET = re.compile(r"^\s*(?:[-*+•]\s+)?")
_SPACE = re.compile(r"\s+")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_HASH_LINE = re.compile(r"^([ \t]*)#", re.MULTILINE)
_thread_lock = threading.Lock()


@dataclass(frozen=True)
class Origin:
    """The chat a line came from.

    :param kind: ``"main"``, ``"side"`` or ``"fork"``.
    :param chat_id: The chat's session id.
    :param title: The chat's title, empty when unknown.
    """

    kind: str
    chat_id: str
    title: str = ""

    @property
    def label(self) -> str:
        """:returns: ``main``, ``side "<title>"`` or ``fork @ "<title>"``."""
        title = _one_line(self.title).replace('"', "'")[:TITLE_MAX_CHARS]
        if self.kind == "main":
            return "main"
        if self.kind == "fork":
            return f'fork @ "{title}"'
        return f'side "{title}"'


def origin_of(chat_id: str, labels: dict[str, str] | None, title: str | None = None) -> Origin:
    """:returns: The :class:`Origin` of a chat, read from its labels (fork, side chat or main)."""
    found = labels or {}
    if SIDE_CHAT_LABEL_KEY not in found:
        return Origin("main", chat_id, title or "")
    kind = "fork" if fork_anchor_id(found) else "side"
    return Origin(kind, chat_id, title or "")


def _one_line(text: str) -> str:
    """:returns: *text* on one line, with nothing that could end the trailing HTML comment."""
    flat = _SPACE.sub(" ", text).strip()
    return flat.replace("<!--", "<!- -").replace("-->", "-- >")


def today(now: datetime | None = None) -> str:
    """:returns: Today's date, ``YYYY-MM-DD``, in UTC."""
    return f"{now or datetime.now(UTC):%Y-%m-%d}"


def format_line(date: str, text: str, origin: Origin) -> tuple[str, str]:
    """:returns: ``(date, line)``: the journal line for *text* on *date* with its origin."""
    body = _one_line(text)
    return date, f"- {date} · {body} · {origin.label} <!-- {_one_line(origin.chat_id)} -->"


def checkpoint_lines(
    origin: Origin,
    journal_lines: Iterable[str] | None,
    evicted_entries: Iterable[str] | None,
    *,
    default_date: str,
) -> list[tuple[str, str]]:
    """The journal lines a stored checkpoint adds.

    :param journal_lines: The item's dated lines; a line without a leading date gets
        *default_date*.
    :param evicted_entries: Entry lines dropped for the size budget, kept word for word (the
        list marker is the only thing removed), each marked as moved out of the working list.
    :returns: ``[(date, line)]``: the journal lines first, then the evicted entries.
    """
    out: list[tuple[str, str]] = []
    for raw in journal_lines or []:
        text = raw.strip()
        if not text:
            continue
        match = _DATE.match(text)
        date, body = (match.group(1), text[match.end() :]) if match else (default_date, text)
        out.append(format_line(date, body, origin))
    for entry in evicted_entries or []:
        body = _BULLET.sub("", entry, count=1).strip()
        if body:
            out.append(format_line(default_date, EVICTED_PREFIX + body, origin))
    return out


def helper_result_line(
    origin: Origin, *, title: str, outcome: str, session_id: str, date: str
) -> tuple[str, str]:
    """:returns: ``(date, line)`` for a Helper Result reaching its Conversation (no body)."""
    name = _one_line(title).replace('"', "'")[:TITLE_MAX_CHARS]
    return format_line(
        date, f'Helper "{name}" {outcome} (session {_one_line(session_id)})', origin
    )


def state_text_of(summary: str | None) -> str:
    """:returns: The state file text of a stored checkpoint summary, without its header."""
    return _strip_seed_header(summary or "").strip()


def memory_dir(workspace: Path) -> Path:
    """:returns: The ``memory/`` folder of *workspace*."""
    return workspace / MEMORY_DIR


@contextlib.contextmanager
def _locked(directory: Path) -> Iterator[None]:
    with _thread_lock:
        if fcntl is None:  # pragma: no cover
            yield
            return
        with open(directory / ".lock", "a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _append(path: Path, lines: list[str]) -> None:
    """Add *lines* under the file's ``## Journal`` heading (created with the file)."""
    block = "".join(f"{line}\n" for line in lines)
    if not path.exists():
        title = f"# {path.stem}\n\n{JOURNAL_HEADING}\n\n"
        path.write_text(title + block, encoding="utf-8")
        return
    text = path.read_text(encoding="utf-8")
    head, found, rest = text.partition(f"\n{JOURNAL_HEADING}\n")
    later = re.search(r"^## ", rest, re.MULTILINE) if found else None
    if later is None:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(("" if text.endswith("\n") else "\n") + block)
        return
    # Another writer's section follows: add at the end of the Journal section, edit nothing.
    cut = later.start()
    section = rest[:cut].rstrip("\n")
    _replace(path, head + found + section + "\n" + block + "\n" + rest[cut:])


def _replace(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def append_lines(
    workspace: Path, entries: Iterable[tuple[str, str]], *, skip_present: bool = False
) -> bool:
    """Append journal lines to the day files, never raising.

    :param entries: ``(date, line)`` pairs in order.
    :param skip_present: Leave out a line the day's file already holds (a rebuild run twice).
    :returns: ``True`` unless a write failed (the failure is logged).
    """
    by_day: dict[str, list[str]] = {}
    for date, line in entries:
        by_day.setdefault(date, []).append(line)
    if not by_day:
        return True
    directory = memory_dir(workspace) / JOURNAL_DIR
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with _locked(directory):
            for date, lines in by_day.items():
                path = directory / f"{date}.md"
                if skip_present and path.exists():
                    held = set(path.read_text(encoding="utf-8").splitlines())
                    lines = [line for line in lines if line not in held]
                lines = list(dict.fromkeys(lines)) if skip_present else lines
                if lines:
                    _append(path, lines)
    except (OSError, ValueError):
        _logger.warning("memory: could not write the journal", exc_info=True)
        return False
    return True


def write_state(workspace: Path, state_text: str) -> bool:
    """Write ``memory/STATE.md``: the note line, then *state_text*. Never raises.

    :returns: ``True`` unless the write failed (the failure is logged).
    """
    directory = memory_dir(workspace)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _replace(directory / STATE_FILE, f"{STATE_NOTE}\n\n{state_text.strip()}\n")
    except OSError:
        _logger.warning("memory: could not write STATE.md", exc_info=True)
        return False
    return True


def reset_state_text(date: str) -> str:
    """:returns: The working list after a reset: one line saying when it was reset."""
    return f"The conversation was reset on {date}."


def _marker(workspace: Path, name: str) -> str | None:
    try:
        return (memory_dir(workspace) / name).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _write_marker(workspace: Path, name: str, value: str) -> bool:
    directory = memory_dir(workspace)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _replace(directory / name, f"{value.strip()}\n")
    except OSError:
        _logger.warning("memory: could not write %s", name, exc_info=True)
        return False
    return True


def owner_of(workspace: Path) -> str | None:
    """:returns: The main Conversation id the folder belongs to, or ``None`` when unmarked."""
    return _marker(workspace, OWNER_FILE)


def write_owner(workspace: Path, main_id: str, *, keep_existing: bool = False) -> bool:
    """Mark the folder as belonging to *main_id*. Never raises.

    :param keep_existing: Leave a marker that is already there (adopting an unmarked folder).
    :returns: ``True`` unless the write failed (the failure is logged).
    """
    if keep_existing and owner_of(workspace) is not None:
        return True
    return _write_marker(workspace, OWNER_FILE, main_id)


def last_reset_of(workspace: Path) -> str | None:
    """:returns: The id of the last reset already written to the files, or ``None``."""
    return _marker(workspace, LAST_RESET_FILE)


def write_last_reset(workspace: Path, item_id: str) -> bool:
    """Record that the reset *item_id* is written to the files. Never raises."""
    return _write_marker(workspace, LAST_RESET_FILE, item_id)


def wipe(workspace: Path) -> bool:
    """Remove the whole ``memory/`` folder. Never raises.

    :returns: ``True`` unless the removal failed (the failure is logged).
    """
    try:
        with _thread_lock:
            shutil.rmtree(memory_dir(workspace), ignore_errors=False)
    except FileNotFoundError:
        return True
    except OSError:
        _logger.warning("memory: could not remove the folder", exc_info=True)
        return False
    return True


def _plain(text: str) -> str:
    """:returns: *text* with every line that starts with ``#`` escaped, so it opens no section."""
    return _HASH_LINE.sub(r"\1\\#", text.strip())


def notes_body(sections: dict[str, str]) -> str:
    """:returns: The note's writer sections as ``### <title>`` blocks, empty ones left out."""
    parts = []
    for key in WRITER_KEYS:
        text = _plain(str(sections.get(key) or ""))
        if text:
            parts.append(f"### {SECTION_TITLES[key]}\n{text}")
    return "\n\n".join(parts)


def _set_section(text: str, heading: str, body: str) -> str:
    """:returns: *text* with the *heading* section replaced by *body* (removed when empty)."""
    match = re.search(rf"^{re.escape(heading)}[ \t]*\n", text, re.MULTILINE)
    start = match.start() if match else len(text)
    nxt = re.compile(r"^## ", re.MULTILINE).search(text, match.end()) if match else None
    end = nxt.start() if nxt else len(text)
    block = f"{heading}\n\n{body}" if body else ""
    return _join(text[:start], block, text[end:])


def _join(before: str, block: str, after: str) -> str:
    parts = [p.strip("\n") for p in (before, block, after) if p.strip("\n")]
    return "\n\n".join(parts) + "\n"


def write_day_sections(workspace: Path, date: str, sections: dict[str, str]) -> bool:
    """Replace the ``## Notes`` and ``## Reflection`` sections of a day file. Never raises.

    The Journal section and its lines are not touched. An empty part writes no section (an old
    one is removed); a day with no file and nothing to write gets none.

    :param sections: The day's note sections, keyed as in the ``daily_notes`` table.
    :returns: ``True`` unless a write failed (the failure is logged).
    """
    if not _DAY.match(date):
        return False
    notes = notes_body(sections)
    reflection = _plain(str(sections.get("reflection") or ""))
    directory = memory_dir(workspace) / JOURNAL_DIR
    path = directory / f"{date}.md"
    try:
        if not path.exists() and not (notes or reflection):
            return True
        directory.mkdir(parents=True, exist_ok=True)
        with _locked(directory):
            if path.exists():
                text = path.read_text(encoding="utf-8")
            else:
                text = f"# {date}\n\n{JOURNAL_HEADING}\n"
            text = _set_section(text, NOTES_HEADING, notes)
            _replace(path, _set_section(text, REFLECTION_HEADING, reflection))
    except (OSError, ValueError):
        _logger.warning("memory: could not write the day sections", exc_info=True)
        return False
    return True
