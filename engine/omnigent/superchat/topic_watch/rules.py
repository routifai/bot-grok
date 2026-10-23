"""The code stages of topic watch (ADR 0035, "Signal filtering"): noise, match and decide.

Pure functions over plain values, no I/O: stage 2's adapters hand in :class:`Item` s, stage 3
drops noise and matches each survivor to one watched topic, and stage 5 turns the judge's
verdict into drop, mark, hold or message under the limits.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

#: The longest item text a source hands on (and the judge reads).
MAX_EXCERPT_CHARS = 1500

STRONG, MEDIUM, WEAK = "strong", "medium", "weak"
_STRENGTH_ORDER = {STRONG: 3, MEDIUM: 2, WEAK: 1}

CHANGES = ("answers_open_item", "new_deadline", "blocker", "new_info", "none")
URGENCIES = ("now", "today", "brief")
#: Changes that may message the person now (with urgency ``now``); a ``new_deadline`` is ``now``
#: only when it falls inside 24 hours, which the judge's urgency says.
MESSAGE_CHANGES = frozenset({"answers_open_item", "blocker", "new_deadline"})
MIN_RELEVANCE = 2

#: One message per topic in this window.
TOPIC_WINDOW_SECONDS = 3 * 3600
#: Messages per local day by proactivity level (``normal`` is "balanced", ``high`` "eager").
DAILY_CAP = {"off": 0, "low": 1, "normal": 3, "high": 6}

DROP, MARK, HOLD, MESSAGE = "drop", "mark", "hold", "message"

_NO_REPLY = re.compile(
    r"^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]daemon|postmaster|bounces?)"
    r"([-_.+].*)?@",
    re.IGNORECASE,
)
_AUTO_SUBJECT = re.compile(
    r"^\s*(auto(matic)?[ -]?(reply|response)|out of (the )?office|autoreply|away:)",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"[\w.+'-]+@[\w-]+(\.[\w-]+)+")


@dataclass(frozen=True)
class Item:
    """One change a source read, before any filtering.

    :param source: ``mail``, ``calendar``, ``files`` or ``web``.
    :param id: The source's own id of this change (a message, an event revision, a version).
    :param title: Subject, event title, file name or page title.
    :param text_excerpt: The item's text, at most :data:`MAX_EXCERPT_CHARS` characters.
    :param at: Epoch seconds the change happened.
    :param thread_ref: The thread, meeting or file the change belongs to, if any.
    :param sender: Who sent or made it (``"Name <address>"`` or an address), if known.
    :param people: Attendees, recipients or editors.
    :param refs: Other hard references the item answers to (a file's name or path).
    :param headers: Mail headers that say what kind of mail it is, names lower-cased.
    :param from_self: The person (or the assistant working for them) made it.
    :param response: A calendar change that is only an attendee's reply: ``accepted``,
        ``tentative`` or ``declined``.
    :param topic_key: The one topic a web item was fetched for.
    """

    source: str
    id: str
    title: str
    text_excerpt: str
    at: int
    thread_ref: str | None = None
    sender: str | None = None
    people: tuple[str, ...] = ()
    refs: tuple[str, ...] = ()
    headers: Mapping[str, str] = field(default_factory=dict)
    from_self: bool = False
    response: str | None = None
    topic_key: str | None = None

    @property
    def key(self) -> str:
        """The seen-set key, ``"<source>:<id>"``."""
        return f"{self.source}:{self.id}"[:255]

    @property
    def thread(self) -> str:
        """What "the same thread" means for this item: its thread, else the item itself."""
        return f"{self.source}:{self.thread_ref}"[:255] if self.thread_ref else self.key


@dataclass(frozen=True)
class WatchedTopic:
    """An open topic as topic watch reads it (from the topics capability).

    :param key: The topic's stable key.
    :param title: Its 2-5 word title.
    :param left_off: Where it stands now, one sentence.
    :param open: Its open lines, ``{kind, text}``.
    :param people: Watched names and addresses.
    :param terms: Watched terms (at most 8).
    :param refs: Hard references: thread, event and file ids it touched.
    :param web: Whether the topic asked to be watched on the web.
    """

    key: str
    title: str
    left_off: str = ""
    open: tuple[Mapping[str, str], ...] = ()
    people: tuple[str, ...] = ()
    terms: tuple[str, ...] = ()
    refs: tuple[str, ...] = ()
    web: bool = False


@dataclass(frozen=True)
class Match:
    """The one topic an item matched and how strongly.

    :param topic_key: The topic.
    :param strength: ``strong``, ``medium`` or ``weak``.
    :param reason: Plain words: which reference, person or terms it hit.
    """

    topic_key: str
    strength: str
    reason: str


@dataclass(frozen=True)
class Verdict:
    """The judge's word on one item, after validation."""

    topic_key: str
    relevance: int
    change: str
    urgency: str
    why: str


@dataclass(frozen=True)
class Decision:
    """What stage 5 does with an item: ``drop``, ``mark``, ``hold`` or ``message``, and why."""

    action: str
    reason: str


@dataclass
class Ledger:
    """The messages already sent (and held) that the limits count.

    :param topic_last: ``topic key -> epoch seconds`` of its newest message.
    :param threads: Threads already messaged about, never again.
    :param today: Messages sent today (the person's local day).
    """

    topic_last: dict[str, int] = field(default_factory=dict)
    threads: set[str] = field(default_factory=set)
    today: int = 0


def watched_topic(raw: Mapping[str, Any]) -> WatchedTopic | None:
    """A topic from ``list_watched_topics`` as :class:`WatchedTopic`; ``None`` without a key."""
    key = str(raw.get("key") or "").strip()
    if not key:
        return None
    watch = raw.get("watch") if isinstance(raw.get("watch"), Mapping) else {}

    def strings(value: Any) -> tuple[str, ...]:
        if not isinstance(value, (list, tuple)):
            return ()
        return tuple(s for s in (str(v).strip() for v in value if v is not None) if s)

    open_lines = tuple(
        {"kind": str(o.get("kind") or ""), "text": str(o.get("text") or "")}
        for o in raw.get("open") or ()
        if isinstance(o, Mapping) and o.get("text")
    )
    return WatchedTopic(
        key=key,
        title=str(raw.get("title") or key),
        left_off=str(raw.get("left_off") or ""),
        open=open_lines,
        people=strings(watch.get("people")),
        terms=strings(watch.get("terms"))[:8],
        refs=strings(watch.get("refs")),
        web=bool(watch.get("web")),
    )


def _address(text: str | None) -> str | None:
    found = _EMAIL.search(text or "")
    return found.group(0).casefold() if found else None


def noise_reason(item: Item) -> str | None:
    """Why *item* is noise and dropped before matching, or ``None`` when it is not.

    Own mail and own work, no-reply and bounce senders, list and bulk mail (newsletters),
    auto-replies, and a calendar reply that only accepts or holds the slot.
    """
    if item.from_self:
        return "own"
    headers = {k.casefold(): str(v).casefold() for k, v in item.headers.items()}
    address = _address(item.sender)
    if address and _NO_REPLY.match(address):
        return "no_reply"
    if "list-id" in headers or "list-unsubscribe" in headers:
        return "list"
    if headers.get("precedence") in ("bulk", "list", "junk"):
        return "bulk"
    auto = headers.get("auto-submitted")
    if (auto and auto != "no") or "x-autoreply" in headers or "x-autorespond" in headers:
        return "auto_reply"
    if item.source == "mail" and _AUTO_SUBJECT.match(item.title):
        return "auto_reply"
    if (
        item.source == "calendar"
        and item.response in ("accepted", "tentative")
        and not item.text_excerpt.strip()
    ):
        return "calendar_reply"
    return None


def _norm(value: str) -> str:
    return " ".join(value.casefold().split())


def _has_phrase(text: str, phrase: str) -> bool:
    """Whether *phrase* occurs in *text* as whole words (both already normalized)."""
    return bool(phrase) and re.search(rf"(?<!\w){re.escape(phrase)}(?!\w)", text) is not None


def _person_hit(item: Item, people: Iterable[str]) -> str | None:
    """The watched person who sent, attends or edited *item*, if any."""
    who = [w for w in (item.sender, *item.people) if w]
    addresses = {a for a in (_address(w) for w in who) if a}
    names = [_norm(_EMAIL.sub(" ", w).replace("<", " ").replace(">", " ")) for w in who]
    for person in people:
        address = _address(person)
        if address and address in addresses:
            return person
        name = _norm(_EMAIL.sub(" ", person).replace("<", " ").replace(">", " "))
        if name and any(_has_phrase(n, name) for n in names):
            return person
    return None


def _muted(mutes: Sequence[Mapping[str, Any]], topic_key: str) -> tuple[set[str], set[str]]:
    """``(muted sender addresses or names, muted terms)`` for one topic, normalized."""
    senders: set[str] = set()
    terms: set[str] = set()
    for mute in mutes:
        if str(mute.get("topic_key") or "") != topic_key:
            continue
        if mute.get("sender"):
            sender = str(mute["sender"])
            senders.add(_address(sender) or _norm(sender))
        if mute.get("term"):
            terms.add(_norm(str(mute["term"])))
    return senders, terms


def _match_one(
    item: Item, topic: WatchedTopic, mutes: Sequence[Mapping[str, Any]]
) -> Match | None:
    muted_senders, muted_terms = _muted(mutes, topic.key)
    if item.sender and (
        (_address(item.sender) or "") in muted_senders or _norm(item.sender) in muted_senders
    ):
        return None
    refs = {_norm(r) for r in topic.refs}
    for ref in (item.thread_ref, item.id, *item.refs):
        if ref and _norm(ref) in refs:
            return Match(topic.key, STRONG, f"watched reference {ref}")
    text = _norm(f"{item.title}\n{item.text_excerpt}")
    terms = {t for t in (_norm(term) for term in topic.terms) if t and t not in muted_terms}
    hits = sorted(t for t in terms if _has_phrase(text, t))
    person = _person_hit(item, topic.people)
    if person and hits:
        return Match(topic.key, MEDIUM, f"from {person}, mentions {', '.join(hits)}")
    if len(hits) >= 2:
        return Match(topic.key, WEAK, f"mentions {', '.join(hits)}")
    return None


def match(
    item: Item, topics: Sequence[WatchedTopic], mutes: Sequence[Mapping[str, Any]] = ()
) -> Match | None:
    """The strongest topic *item* hits, or ``None`` (ADR 0035 stage 3).

    Strong: a hard reference (thread, meeting or file the topic touched). Medium: a watched
    person sent, attends or edited it and it contains a watched term. Weak: it contains two or
    more distinct watched terms of one topic. A muted sender never matches that topic and a
    muted term never counts for it. A web item matches only the topic it was fetched for. Ties
    go to the earlier topic in *topics*.
    """
    best: Match | None = None
    for topic in topics:
        if item.topic_key is not None and topic.key != item.topic_key:
            continue
        found = _match_one(item, topic, mutes)
        if found and (
            best is None or _STRENGTH_ORDER[found.strength] > _STRENGTH_ORDER[best.strength]
        ):
            best = found
    return best


def decide(
    verdict: Verdict,
    item: Item,
    *,
    now: int,
    quiet: bool,
    proactivity: str,
    ledger: Ledger,
) -> Decision:
    """What to do with a judged item (ADR 0035 stage 5); records a message in *ledger*.

    Nothing reaches the person unless relevance is at least 2 and the change is not ``none``.
    A message goes now only for an answer to an open item, a blocker or a deadline inside 24
    hours (urgency ``now``), within the limits: one per topic per 3 hours, the daily cap of the
    proactivity level, and never twice for one thread. Quiet hours hold it until they end. Every
    other kept item only marks its topic (the caller marks a message's topic too).
    """
    if verdict.relevance < MIN_RELEVANCE:
        return Decision(DROP, f"relevance {verdict.relevance}")
    if verdict.change == "none":
        return Decision(DROP, "no change")
    if verdict.change not in MESSAGE_CHANGES or verdict.urgency != "now":
        return Decision(MARK, f"{verdict.change}, {verdict.urgency}")
    if item.thread in ledger.threads:
        return Decision(MARK, "thread already surfaced")
    last = ledger.topic_last.get(verdict.topic_key)
    if last is not None and now - last < TOPIC_WINDOW_SECONDS:
        return Decision(MARK, "topic messaged in the last 3 hours")
    if ledger.today >= DAILY_CAP.get(proactivity, DAILY_CAP["normal"]):
        return Decision(MARK, f"daily cap ({proactivity})")
    ledger.topic_last[verdict.topic_key] = now
    ledger.threads.add(item.thread)
    ledger.today += 1
    if quiet:
        return Decision(HOLD, f"{verdict.change}, now; held for quiet hours")
    return Decision(MESSAGE, f"{verdict.change}, now")
