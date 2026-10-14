"""The tagged state file: entry format, repair after a rewrite, budget and journal split.

The state file is free text the summarizer rewrites at every checkpoint. Some of its lines are
*entries*: one line that starts with a tag, ``[id · date]``::

    - [t-launch-budget · 2026-10-09] Spring launch budget: confirm the venue line
    - [o-venue · 2026-10-09] closed: the venue is booked
    - [t-old-plan · 2026-09-30] merged into [t-launch-budget]: same topic
    - [o-dana-reply · 2026-09-01 · stale?] waiting on Dana's reply

The id says what it is (``t-`` topic, ``d-`` decision, ``o-`` open loop). The id alone is the
identity of an entry; the date and the ``closed`` / ``merged into`` marks are attributes, so a
changed date is never a lost entry. ``stale?`` is a rendering of the date (:func:`mark_stale`),
never stored: :func:`parse` drops it. Every other line (headings, the position paragraph) is free
text and passes through as written.

Everything here is pure: no I/O, no model call. :func:`reconcile` is the one entry point the
rollover uses after the summarizer returns.
"""

from __future__ import annotations

import datetime
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace

from omnigent.context.labels import STATE_CLOSE_LABEL_PREFIX

#: Token budget of the rendered state file.
STATE_FILE_BUDGET_TOKENS = 4_000
#: Longest text of one entry; a longer one is cut, so a single entry cannot crowd out the rest.
ENTRY_MAX_CHARS = 400
#: Word overlap (Jaccard) from which two open entries of the same kind are hinted as one thing,
#: the fewest words they must share, and the most pairs hinted at once.
DUPLICATE_OVERLAP = 0.6
DUPLICATE_MIN_SHARED = 3
DUPLICATE_MAX_HINTS = 5
#: Journal lines kept from one summarizer reply, and the longest one.
JOURNAL_MAX_LINES = 10
JOURNAL_LINE_MAX_CHARS = 300
#: Longest reason kept for a ``state_close``, so a label value (256 chars) always holds it.
CLOSE_REASON_MAX_CHARS = 200
#: Longest tag id ``state_close`` accepts; the label key (128 chars) holds the prefix plus it.
TAG_ID_MAX_CHARS = 64
#: Days without a touch after which an open entry renders ``stale?``.
STALE_AFTER_DAYS = 30
STALE_MARK = " · stale?"

_ID = r"[tdo]-[a-z0-9]+(?:-[a-z0-9]+)*"
_TAG = re.compile(
    rf"^(?P<prefix>\s*(?:[-*+]\s+)?)\[(?P<id>{_ID})(?:\s*[·|,]\s*(?P<date>\d{{4}}-\d{{2}}-\d{{2}}))?"
    r"(?P<stale>\s*[·|,]?\s*stale\?)?\](?P<rest>.*)$"
)
#: A ``stale?`` the model moved out of the tag, right after it.
_STALE_AFTER_TAG = re.compile(r"^\s*[·|,]?\s*stale\?")
_CLOSED = re.compile(r"^\s*closed(?:\s*[:·—-]\s*|\s*$)")
_MERGED = re.compile(rf"^\s*merged into \[(?P<target>{_ID})\](?:\s*[:·—-]\s*|\s+|$)")
_JOURNAL = re.compile(r"<journal>(.*?)(?:</journal>|\Z)", re.DOTALL | re.IGNORECASE)
_BULLET = re.compile(r"^\s*(?:[-*•+]\s+)?")


@dataclass(frozen=True)
class Entry:
    """One tagged line of the state file.

    :param id: The stable tag id, e.g. ``"t-launch-budget"``. The entry's identity.
    :param date: Last-touched ISO date, or ``None`` when the tag came back without one.
    :param closed: Marked ``closed``.
    :param merged_into: The id it is marked ``merged into``, if any.
    :param body: The text after the tag and marks.
    :param prefix: Indentation and bullet before the tag.
    :param line: The full line, as written (or as last rendered after an attribute change).
    """

    id: str
    date: str | None
    closed: bool
    merged_into: str | None
    body: str
    prefix: str
    line: str

    @property
    def done(self) -> bool:
        """:returns: Whether the entry is closed or merged (the first to be evicted)."""
        return self.closed or self.merged_into is not None

    def with_attrs(
        self,
        *,
        date: str | None = None,
        closed: bool | None = None,
        merged_into: str | None = None,
    ) -> Entry:
        """:returns: A copy with the given attributes changed and the line rendered again."""
        changed = replace(
            self,
            date=self.date if date is None else date,
            closed=self.closed if closed is None else closed,
            merged_into=self.merged_into if merged_into is None else merged_into,
        )
        return replace(changed, line=_render_entry(changed))


def _render_entry(entry: Entry) -> str:
    tag = f"[{entry.id} · {entry.date}]" if entry.date else f"[{entry.id}]"
    if entry.merged_into:
        mark = f" merged into [{entry.merged_into}]"
    elif entry.closed:
        mark = " closed"
    else:
        mark = ""
    sep = ":" if mark and entry.body else ""
    body = f" {entry.body}" if entry.body else ""
    return f"{entry.prefix}{tag}{mark}{sep}{body}"


#: A state file line: an :class:`Entry`, or free text kept as written.
Line = Entry | str


def parse(text: str) -> list[Line]:
    """Split *text* into lines, turning each tagged line into an :class:`Entry`.

    :returns: The lines in order; :func:`render` gives *text* back for canonical entries.
    """
    lines: list[Line] = []
    for raw in text.split("\n"):
        match = _TAG.match(raw)
        if match is None:
            lines.append(raw)
            continue
        rest = match["rest"]
        # ``stale?`` is recomputed at every checkpoint: drop it, keep the rest word for word.
        moved = _STALE_AFTER_TAG.match(rest)
        if moved is not None:
            rest = rest[moved.end() :]
            raw = raw[: match.start("rest")] + rest
        if match["stale"] is not None:
            raw = raw[: match.start("stale")] + raw[match.end("stale") :]
        closed = False
        merged_into = None
        merged = _MERGED.match(rest)
        if merged is not None:
            merged_into = merged["target"]
            rest = rest[merged.end() :]
        else:
            done = _CLOSED.match(rest)
            if done is not None:
                closed = True
                rest = rest[done.end() :]
        lines.append(
            Entry(
                id=match["id"],
                date=match["date"],
                closed=closed,
                merged_into=merged_into,
                body=rest.strip(),
                prefix=match["prefix"],
                line=raw,
            )
        )
    return lines


def render(lines: list[Line]) -> str:
    """:returns: The text of *lines*; an entry renders as it was written or last changed."""
    return "\n".join(line if isinstance(line, str) else line.line for line in lines)


def entries(lines: list[Line]) -> dict[str, Entry]:
    """:returns: The entries by id, in order; a repeated id keeps its first line."""
    found: dict[str, Entry] = {}
    for line in lines:
        if isinstance(line, Entry):
            found.setdefault(line.id, line)
    return found


def _insert(lines: list[Line], added: list[Entry]) -> list[Line]:
    """*lines* with *added* after the last entry (else after the last non-blank line)."""
    at = next((i + 1 for i in range(len(lines) - 1, -1, -1) if isinstance(lines[i], Entry)), None)
    if at is None:
        at = next((i + 1 for i in range(len(lines) - 1, -1, -1) if str(lines[i]).strip()), 0)
    return [*lines[:at], *added, *lines[at:]]


def _swap(lines: list[Line], entry_id: str, new: Entry) -> list[Line]:
    return [new if isinstance(line, Entry) and line.id == entry_id else line for line in lines]


def apply_closes(
    previous: list[Line], new: list[Line], closes: Mapping[str, str], *, today: str
) -> tuple[list[Line], list[dict[str, str]]]:
    """Mark the pending closes in the rewritten file.

    An entry the rewrite dropped is put back from *previous*, already closed, so the repair that
    follows does not bring it back open. A tag found in neither version is skipped.

    :param closes: ``{id: reason}`` recorded by ``state_close``.
    :returns: ``(lines, applied)``; *applied* is ``[{"tag": id, "reason": reason}]``.
    """
    applied: list[dict[str, str]] = []
    before = entries(previous)
    for tag, reason in closes.items():
        present = entries(new).get(tag)
        found = present or before.get(tag)
        if found is None:
            continue
        closed = found if found.closed else found.with_attrs(date=today, closed=True)
        new = _swap(new, tag, closed) if present else _insert(new, [closed])
        applied.append({"tag": tag, "reason": reason})
    return new, applied


def repair(previous: list[Line], new: list[Line]) -> tuple[list[Line], int]:
    """Put back, word for word, every entry the rewrite lost.

    Lost means: its id is absent from *new*, or *new* marks it ``merged into`` an id that is not in
    *new* (the fold names nothing). An entry *new* marks ``closed`` or ``merged into`` a present
    id is kept as *new* has it. Never rejects: the rewrite is accepted with the repairs made.

    :returns: ``(lines, repairs)``; *repairs* counts the entries put back.
    """
    now = entries(new)
    repairs = 0
    restored: list[Entry] = []
    for tag, old in entries(previous).items():
        current = now.get(tag)
        if current is None:
            restored.append(old)
        elif (
            current.merged_into is not None
            and current.merged_into not in now
            and old.merged_into != current.merged_into
        ):
            new = _swap(new, tag, old)
            repairs += 1
    return (_insert(new, restored) if restored else new), repairs + len(restored)


def carry_dates(previous: list[Line], lines: list[Line], *, today: str) -> list[Line]:
    """Give every entry that came back without a date its previous date, else *today*."""
    before = entries(previous)
    out: list[Line] = []
    for line in lines:
        if isinstance(line, Entry) and line.date is None:
            old = before.get(line.id)
            line = line.with_attrs(date=(old.date if old and old.date else today))
        out.append(line)
    return out


def mark_stale(lines: list[Line], *, today: str) -> list[Line]:
    """Add ``stale?`` to the tag of every open entry untouched for :data:`STALE_AFTER_DAYS`.

    A rendering of the date for the model and ``STATE.md``, never stored state: :func:`parse`
    drops it, so it cannot change an entry's identity, a repair or the eviction order.

    :param today: The checkpoint's ISO date.
    """
    try:
        now = datetime.date.fromisoformat(today)
    except ValueError:
        return lines
    out: list[Line] = []
    for line in lines:
        if isinstance(line, Entry) and not line.done and line.date:
            try:
                age = (now - datetime.date.fromisoformat(line.date)).days
            except ValueError:
                age = 0
            if age >= STALE_AFTER_DAYS:
                match = _TAG.match(line.line)
                if match is not None:
                    at = match.end("date")
                    line = replace(line, line=line.line[:at] + STALE_MARK + line.line[at:])
        out.append(line)
    return out


def clip_entries(lines: list[Line]) -> list[Line]:
    """Cut every entry's text to :data:`ENTRY_MAX_CHARS` (an ellipsis marks the cut)."""
    out: list[Line] = []
    for line in lines:
        if isinstance(line, Entry) and len(line.body) > ENTRY_MAX_CHARS:
            cut = replace(line, body=line.body[: ENTRY_MAX_CHARS - 1].rstrip() + "…")
            line = replace(cut, line=_render_entry(cut))
        out.append(line)
    return out


_WORD = re.compile(r"[a-z0-9]{4,}")


def likely_duplicates(text: str | None) -> list[tuple[str, str]]:
    """Pairs of open entries of the same kind whose wording overlaps heavily.

    A hint for the summarizer, never a decision: similar words are not the same topic, so the
    code only points and the model merges (``merged into``) when they are.

    :returns: Up to :data:`DUPLICATE_MAX_HINTS` ``(id, id)`` pairs, most alike first.
    """
    words = {
        entry.id: set(_WORD.findall(entry.body.lower()))
        for entry in entries(parse(text or "")).values()
        if not entry.done
    }
    scored: list[tuple[float, str, str]] = []
    ids = list(words)
    for i, first in enumerate(ids):
        for second in ids[i + 1 :]:
            shared = words[first] & words[second]
            if first[:2] != second[:2] or len(shared) < DUPLICATE_MIN_SHARED:
                continue
            overlap = len(shared) / len(words[first] | words[second])
            if overlap >= DUPLICATE_OVERLAP:
                scored.append((overlap, first, second))
    scored.sort(key=lambda pair: -pair[0])
    return [(first, second) for _, first, second in scored[:DUPLICATE_MAX_HINTS]]


def fit_budget(
    lines: list[Line], budget: int, count: Callable[[str], int]
) -> tuple[list[Line], list[str]]:
    """Evict entries until the rendered file fits *budget* tokens.

    Closed and merged entries go first, oldest date first; when none are left, open entries,
    oldest date first. The evicted lines come back word for word from the same call that drops
    them, so the caller writes them down before the trimmed text is used. Free text is never
    evicted: the loop stops when no entry is left.

    :param count: Token counter for a text.
    :returns: ``(lines, evicted)``; *evicted* are the entry lines, in eviction order.
    """
    lines = list(lines)
    evicted: list[str] = []
    while count(render(lines)) > budget:
        candidates = [(i, line) for i, line in enumerate(lines) if isinstance(line, Entry)]
        if not candidates:
            break
        index, victim = min(candidates, key=lambda c: (not c[1].done, c[1].date or "", c[0]))
        evicted.append(victim.line)
        del lines[index]
    return lines, evicted


@dataclass(frozen=True)
class Reconciled:
    """The state file after a rewrite, with what the code did to it.

    :param text: The final state file text.
    :param repairs: Entries put back because the rewrite lost them.
    :param evicted: Entry lines dropped for the budget, word for word.
    :param applied_closes: ``[{"tag": id, "reason": reason}]`` applied from ``state_close``.
    """

    text: str
    repairs: int
    evicted: list[str]
    applied_closes: list[dict[str, str]]


def reconcile(
    previous_text: str | None,
    new_text: str,
    *,
    closes: Mapping[str, str] | None = None,
    today: str,
    count: Callable[[str], int],
    budget: int = STATE_FILE_BUDGET_TOKENS,
) -> Reconciled:
    """Check a rewritten state file against the previous one.

    In order: apply the pending closes, repair lost entries, carry dates forward, cut overlong
    entries, fit the budget, then mark stale entries (after eviction, so evicted lines go to the
    journal without the mark). A previous file with no tags (stored before tags existed) has
    nothing to lose.

    :param previous_text: The previous state file (no checkpoint header), or ``None``.
    :param new_text: The summarizer's state file (no journal section).
    :param closes: Pending ``{id: reason}`` closes.
    :param today: ISO date for entries the code touches.
    :param count: Token counter for a text.
    :param budget: Token budget of the rendered file.
    """
    before = parse(previous_text or "")
    lines, applied = apply_closes(before, parse(new_text), closes or {}, today=today)
    lines, repairs = repair(before, lines)
    lines = clip_entries(carry_dates(before, lines, today=today))
    lines, evicted = fit_budget(lines, budget, count)
    return Reconciled(render(mark_stale(lines, today=today)), repairs, evicted, applied)


def split_journal(text: str) -> tuple[str, list[str]]:
    """Split the ``<journal>`` section off a summarizer reply.

    :returns: ``(state_text, journal_lines)``. No section, or an empty one, gives no lines.
    """
    match = _JOURNAL.search(text)
    if match is None:
        return text, []
    state = (text[: match.start()] + text[match.end() :]).strip()
    lines = [_BULLET.sub("", raw).strip() for raw in match.group(1).splitlines()]
    kept = [line[:JOURNAL_LINE_MAX_CHARS] for line in lines if line]
    return state, kept[:JOURNAL_MAX_LINES]


def normalize_tag(raw: str) -> str | None:
    """:returns: The id in *raw* (with or without brackets, date and dot), or ``None``."""
    text = raw.strip().strip("[]").split("·")[0].split("|")[0].strip().lower()
    if len(text) > TAG_ID_MAX_CHARS or re.fullmatch(_ID, text) is None:
        return None
    return text


def close_label_key(tag: str) -> str:
    """:returns: The session label that holds a pending close for *tag*."""
    return f"{STATE_CLOSE_LABEL_PREFIX}{tag}"


def pending_closes(labels: Mapping[str, str] | None) -> dict[str, str]:
    """:returns: ``{id: reason}`` of the pending close labels; a cleared (empty) one is skipped."""
    found: dict[str, str] = {}
    for key, value in (labels or {}).items():
        if key.startswith(STATE_CLOSE_LABEL_PREFIX) and value.strip():
            found[key.removeprefix(STATE_CLOSE_LABEL_PREFIX)] = value.strip()
    return found


def close_journal_line(close: Mapping[str, str], *, today: str) -> str:
    """:returns: The journal line for an applied close, e.g. ``2026-10-12 · closed [t-x]: why``."""
    return f"{today} · closed [{close['tag']}]: {close['reason']}"
