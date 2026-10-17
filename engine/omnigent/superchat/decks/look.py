"""A new deck's look: kept when the person's words or the task record back it, else chosen.

ADR 0025: a deliverable is started in the same turn, so a new deck is never held up by a "Which
look?" card. ``deck_new`` says where its look came from (``look_from``) and keeps the template
when something the model cannot write itself backs it:

* ``named``: the person's latest message names the theme (its name or id), or a mood word
  (:data:`MOODS`) whose themes include it;
* ``picked``: the task record holds the person's pick of this theme (a card answer the engine
  recorded), or the latest message is that answer;
* ``you_choose``: the message hands the choice over (:data:`YOU_CHOOSE_PHRASES`);
* ``background``: the work is a scheduled or ad-hoc Helper run, or a scheduled fire (server labels
  on the session or its parents), so there is no person to ask.

Anything else (``ask``, missing, or a claim nothing backs) is chosen by :func:`choose_look` from
the topic and the person's taste, and the file card offers "Change look". The one refusal left is
:data:`HELPER_REFUSAL`, for background work whose request has no topic to choose from.

The latest message and the record come from the server's task view of the Conversation (a
Helper's: the chat that started it), see :mod:`omnigent.superchat.tasks`.

Limits: matching is on words, case-insensitive. A mood word in passing ("the tech team") counts
as naming that mood; a delegation phrase in passing ("just do it with Q3") counts as handing over
the choice.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from omnigent.superchat.decks import kit
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.prompt_prefix import fetch_memory_profile
from omnigent.superchat.tasks.runtime import read_tasks

#: Mood words the person may use instead of a theme name -> the themes that mood fits. The same
#: table is in decks.md, so the Muse and the gate read moods alike.
MOODS: dict[str, tuple[str, ...]] = {
    **dict.fromkeys(
        ("formal", "board", "bank report", "finance", "management"),
        ("corporate-clean", "blue-professional", "swiss-grid", "arctic-cool"),
    ),
    **dict.fromkeys(("minimal", "clean", "simple", "calm"), ("minimal-white", "japanese-minimal")),
    **dict.fromkeys(("dark", "night", "tech", "developer"), ("nord", "tokyo-night")),
    **dict.fromkeys(("academic", "research", "paper", "thesis"), ("academic-paper",)),
    **dict.fromkeys(
        ("editorial", "magazine", "storytelling", "narrative"),
        ("editorial-serif", "magazine-mono", "cartesian", "magazine-bold"),
    ),
    **dict.fromkeys(
        ("fun", "playful", "bold", "colourful", "colorful", "creative"),
        ("bauhaus", "midcentury", "editorial-tri-tone", "sharp-mono"),
    ),
    **dict.fromkeys(("pitch", "investors", "startup"), ("pitch-deck-vc",)),
}

#: What counts as handing the choice to the Muse. Short on purpose: anything else gets the card.
YOU_CHOOSE_PHRASES = (
    "you choose",
    "you pick",
    "you decide",
    "your call",
    "your choice",
    "up to you",
    "just do it",
    "surprise me",
    "any look",
    "any theme",
)
HELPER_REFUSAL = (
    "The person hasn't chosen a look and the request has no topic to choose one from. Stop and "
    "report back that the look must be settled first; do not pick one."
)
#: Recorded as ``look_from`` when the engine chose the look.
CHOSEN = "chosen"


def _has(text: str, phrase: str) -> bool:
    """Whether *phrase* occurs in *text* as whole words (both already lower-case)."""
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def _named(text: str, theme_id: str) -> bool:
    template = kit.templates()[theme_id]
    return any(
        _has(text, n) for n in {template.name.lower(), theme_id, theme_id.replace("-", " ")}
    )


def named_themes(text: str) -> set[str]:
    """Themes *text* names outright (name or id)."""
    low = text.lower()
    return {theme_id for theme_id in kit.templates() if _named(low, theme_id)}


def mood_themes(text: str) -> set[str]:
    """Themes a mood word in *text* fits."""
    low = text.lower()
    return {t for mood, themes in MOODS.items() if _has(low, mood) for t in themes}


#: What a deck is about -> the kind of look that suits it. Words match whole and lower-case, digits
#: included, so "2026 sales" finds "sales" and "Q3" finds "q3".
TOPICS: dict[str, tuple[str, ...]] = {
    "professional": (
        *("sales", "revenue", "revenues", "quarter", "quarterly", "q1", "q2", "q3", "q4"),
        *("finance", "financial", "budget", "budgets", "board", "kpi", "kpis", "report"),
        *("review", "forecast", "metrics", "results", "earnings", "operations", "strategy"),
        *("audit", "compliance", "bank", "client", "clients", "annual", "growth", "pipeline"),
        *("profit", "margin", "plan", "hiring", "management", "update"),
    ),
    "academic": (
        *("research", "study", "paper", "thesis", "lecture", "science", "scientific"),
        *("university", "seminar", "literature", "methodology", "academic", "course"),
    ),
    "editorial": (
        *("travel", "trip", "culture", "food", "story", "history", "art", "city", "museum"),
        *("book", "writing", "festival", "wine", "journey", "heritage", "magazine"),
    ),
    "bold": (
        *("pitch", "launch", "startup", "investor", "investors", "product", "campaign"),
        *("marketing", "brand", "fundraising", "event", "kickoff", "announcement"),
    ),
    "dark": (
        *("tech", "technical", "engineering", "engineers", "developer", "developers", "api"),
        *("architecture", "platform", "security", "infrastructure", "software", "code", "ai"),
    ),
}
#: Each kind's looks, best fit first. The card leads with one of a kind's first two (which one
#: varies by request), so a sales deck opens on Corporate Clean or Blue Professional.
LEADS: dict[str, tuple[str, ...]] = {
    "professional": (
        *("corporate-clean", "blue-professional", "swiss-grid", "arctic-cool", "minimal-white"),
    ),
    "academic": ("academic-paper", "minimal-white", "swiss-grid"),
    "editorial": (
        *("editorial-serif", "magazine-bold", "cartesian", "japanese-minimal", "magazine-mono"),
    ),
    "bold": ("pitch-deck-vc", "bauhaus", "midcentury", "editorial-tri-tone", "sharp-mono"),
    "dark": ("tokyo-night", "nord", "sharp-mono", "magazine-mono"),
}
#: Beside the best fit, one look from each of these theme categories: distinct, plausible
#: alternatives (a business deck gets an editorial and a bold one, never a night theme).
ALTERNATIVES: dict[str, tuple[str, str]] = {
    "professional": ("editorial", "bold"),
    "editorial": ("professional", "bold"),
    "bold": ("editorial", "professional"),
    "dark": ("bold", "professional"),
}
#: The kind a request with no topic word gets: decks.md's default is a professional look.
DEFAULT_KIND = "professional"
_STOP = {"with", "from", "that", "this", "your", "deck", "slides", "make", "about", "into"}


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower())) - _STOP


def _turn(seed: str, theme_id: str) -> str:
    """A stable tiebreak: the same request ranks equal themes the same way, others differently."""
    return hashlib.sha256(f"{seed}|{theme_id}".encode()).hexdigest()


def topic_kinds(hint: str) -> list[str]:
    """The kinds of look *hint*'s topic words call for, most words first (none: the default)."""
    words = _words(hint)
    hits = {kind: len(words & set(keys)) for kind, keys in TOPICS.items()}
    return sorted((k for k, n in hits.items() if n), key=lambda k: -hits[k]) or [DEFAULT_KIND]


def pick_three(hint: str, *, seed: str = "") -> list[str]:
    """Three themes for *hint* (the deck's title and request): the best fit, then two alternatives.

    A named theme counts most, then a mood word (:data:`MOODS`), then the topic's kind
    (:data:`TOPICS`, whose :data:`LEADS` order the looks), then the dictionary's own words
    (``best_for`` / ``mood`` / ``tagline``). The other two come from the categories
    :data:`ALTERNATIVES` pairs with the first. Equal themes are ordered by a hash of *seed* (the
    chat and request), so offers vary without being random.
    """
    templates = kit.templates()
    words = {w for w in _words(hint) if len(w) > 3}
    named, moods, kinds = named_themes(hint), mood_themes(hint), topic_kinds(hint)
    weight = {k: 3 * len(_words(hint) & set(TOPICS[k])) for k in kinds}

    def lead(theme_id: str) -> int:
        """Where *theme_id* stands in the topic's looks, else in its own category's."""
        for k in kinds:
            if theme_id in LEADS[k]:
                return LEADS[k].index(theme_id)
        own = LEADS.get(templates[theme_id].category, ())
        return 10 + own.index(theme_id) if theme_id in own else 20

    def rank(theme_id: str) -> tuple[int, int, str]:
        t = templates[theme_id]
        score = (
            8 * (theme_id in named)
            + 4 * (theme_id in moods)
            + sum(w for k, w in weight.items() if theme_id in LEADS[k])
            + len(words & _words(f"{t.best_for} {t.description} {t.tagline}"))
        )
        return -score, lead(theme_id) // 2, _turn(seed or hint, theme_id)

    ranked = sorted(templates, key=rank)
    first = ranked[0]
    others = ALTERNATIVES[templates[first].category]
    return [first, *(next(t for t in ranked if templates[t].category == c) for c in others)]


def has_topic(text: str) -> bool:
    """Whether *text* says anything a look can be chosen from (a theme, a mood or a topic)."""
    words = _words(text)
    return bool(
        named_themes(text) or mood_themes(text) or any(words & set(k) for k in TOPICS.values())
    )


def remembered_themes(profile: str | None) -> list[str]:
    """Themes the person's Memory Profile names, in the order it names them."""
    low = (profile or "").lower()
    found: list[tuple[int, str]] = []
    for theme_id in named_themes(low):
        template = kit.templates()[theme_id]
        spots = [
            m.start()
            for n in (template.name.lower(), theme_id, theme_id.replace("-", " "))
            if (m := re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![a-z0-9])", low))
        ]
        found.append((min(spots), theme_id))
    return [theme_id for _, theme_id in sorted(found)]


def choose_look(topic_text: str, memory_order: Sequence[str] = ()) -> str:
    """The look for a new deck about *topic_text*: the first theme in the ordering.

    A theme or mood the topic names comes first (:func:`pick_three`'s ranking). Otherwise the
    person's remembered taste (*memory_order*) leads where it fits the topic's kind of look
    (:data:`TOPICS` / :data:`LEADS`), or anywhere when the topic says nothing; then the topic's
    best fit.
    """
    ranked = pick_three(topic_text, seed=topic_text)
    if named_themes(topic_text) or mood_themes(topic_text):
        return ranked[0]
    words = _words(topic_text)
    kinds = [k for k, keys in TOPICS.items() if words & set(keys)]
    fits = {theme for k in kinds for theme in LEADS[k]}
    templates = kit.templates()
    for theme_id in memory_order:
        if theme_id in templates and (not kinds or theme_id in fits):
            return theme_id
    return ranked[0]


@dataclass(frozen=True)
class Look:
    """How a new deck's look was settled.

    :param theme: The theme to build in.
    :param look_from: Where it came from: the backed ``look_from``, or :data:`CHOSEN`.
    :param refusal: Why nothing may be built (background work with no topic), else ``None``.
    :param why: Why the engine chose, for the model (empty when the look was kept).
    """

    theme: str
    look_from: str
    refusal: str | None = None
    why: str = ""

    @property
    def chosen(self) -> bool:
        """The engine chose the look (the model's template was not backed)."""
        return self.look_from == CHOSEN


def backed(look_from: object, theme_id: str, view: Mapping[str, Any]) -> bool:
    """Whether the person's words or the task record back *look_from* for *theme_id*."""
    message = str(view.get("message") or "").lower()
    if look_from == "named":
        return theme_id in named_themes(message) | mood_themes(message)
    if look_from == "picked":
        answer = view.get("answer")
        label = str(answer.get("label") or "") if isinstance(answer, dict) else ""
        if label and named_themes(label) == {theme_id}:
            return True
        return any(
            isinstance(t, dict)
            and t.get("kind") == "deck"
            and isinstance(t.get("fields"), dict)
            and t["fields"].get("look_id") == theme_id
            for t in view.get("tasks") or ()
        )
    if look_from == "you_choose":
        return any(_has(message, p) for p in YOU_CHOOSE_PHRASES)
    if look_from == "background":
        return view.get("background") is True
    return False


async def settle_look(
    ctx: HandlerCtx | None, look_from: object, theme_id: str, title: str
) -> Look:
    """The look a new deck titled *title* is built in (see the module doc)."""
    client = ctx.server_client if ctx is not None else None
    session = ctx.conversation_id if ctx is not None else None
    view = await read_tasks(client, session) or {}
    if backed(look_from, theme_id, view):
        return Look(theme_id, str(look_from))
    topic = f"{title} {view.get('message') or ''}".strip()
    if view.get("background") is True and not has_topic(topic):
        return Look(theme_id, str(look_from), HELPER_REFUSAL)
    profile = await fetch_memory_profile(client, session)
    why = (
        "no look was named"
        if look_from in (None, "ask")
        else f"nothing the person said or picked backs look_from {look_from}"
    )
    return Look(choose_look(topic, remembered_themes(profile)), CHOSEN, why=why)
