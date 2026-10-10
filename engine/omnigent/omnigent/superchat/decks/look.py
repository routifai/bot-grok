"""The look gate: a new deck is built only in a look the person chose, checked against records.

``deck_new`` says where its look came from (``look_from``). The model's word is not enough, so
each value is checked against something it cannot write itself:

* ``named``: the person's latest message names the theme (its name or id), or a mood word
  (:data:`MOODS`) whose themes include it;
* ``picked``: the card shown just before that message offered deck themes, and the message picks
  exactly this one (the card's button sends the theme's name);
* ``you_choose``: the message hands the choice over (:data:`YOU_CHOOSE_PHRASES`);
* ``preference`` is not accepted: memory is not exact enough to stand in for the person's
  choice (a remembered taste may only order the offered looks), so it gets the card;
* ``background``: the work is a scheduled or ad-hoc Helper run, or a scheduled fire (server
  labels on the session or its parents), so there is no person to ask.

A Helper is checked against the person-facing chat that owns it (its family root, found by
walking ``parent_session_id`` up): the Muse settles the look before delegating, so the pick or
the name is in that chat. When the check fails in a Helper, nothing is built and ``deck_new``
refuses with :data:`HELPER_REFUSAL` (a card there would reach no one); the Helper reports back
and the Muse asks.

The person's latest message is the newest user message in the session's stored items that a
person typed (runtime notices and hidden context are skipped). When the check fails, or
``look_from`` is missing or ``ask``, ``deck_new`` builds nothing and returns the "Which look?"
card itself (:func:`look_card`), which ends the turn. Without server access nothing can be
checked, so the card is the answer.

Limits: matching is on words, case-insensitive. A mood word in passing ("the tech team")
counts as naming that mood; a delegation phrase in passing ("just do it with Q3") counts as
handing over the choice.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from omnigent.context.labels import (
    ADHOC_HELPER_LABEL_KEY,
    SCHEDULED_FIRE_LABEL_KEY,
    SCHEDULED_HELPER_LABEL_KEY,
)
from omnigent.entities.conversation import is_system_notice_text
from omnigent.superchat.cards.tools import build_clarification
from omnigent.superchat.decks import kit
from omnigent.superchat.feature import HandlerCtx

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

#: Words that make a memory claim about deck looks.
#: Newest stored items read to find the latest message and the card before it.
ITEMS_SCANNED = 60
QUESTION = "Which look?"
_SUB_AGENT = "sub_agent"
#: Labels the server stamps on a run no person started (a schedule, a Goal's cadence, a pass).
_BACKGROUND_LABELS = (SCHEDULED_HELPER_LABEL_KEY, ADHOC_HELPER_LABEL_KEY, SCHEDULED_FIRE_LABEL_KEY)
#: Helpers nest one level (a worker's subworker); a deeper chain is not followed.
_MAX_HOPS = 4
HELPER_REFUSAL = (
    "The person hasn't chosen a look. Stop and report back that the look must be settled "
    "first; do not pick one."
)
#: The tools whose stored output may be the "Which look?" card the person answered.
_CARD_TOOLS = frozenset({"deck_new", "ask_clarification"})
_MCP_PREFIX = "mcp__omnigent__"


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


@dataclass(frozen=True)
class LookEvidence:
    """What the server holds about this choice; nothing here comes from the model.

    :param is_helper: The caller is a Helper; the rest was read from its family's root chat.
    :param background: A schedule or an ad-hoc pass started this work, not a person.
    :param message: The person's latest message, or ``""``.
    :param offered: ``(label, theme id)`` of the deck-theme card shown just before that message,
        or ``None`` when there was none.
    :param chat: The person-facing chat the records were read from.
    :param declined: Themes an earlier card offered that the person did not pick.
    """

    is_helper: bool = False
    background: bool = False
    message: str = ""
    offered: tuple[tuple[str, str], ...] | None = None
    chat: str = ""
    declined: frozenset[str] = frozenset()


def check_look(look_from: object, theme_id: str, evidence: LookEvidence) -> str | None:
    """Why *look_from* does not hold for *theme_id*, or ``None`` when the records confirm it."""
    message = evidence.message.lower()
    if look_from == "named":
        if theme_id in named_themes(message) | mood_themes(message):
            return None
        return "the person's message does not name this theme or a mood it fits."
    if look_from == "picked":
        if evidence.offered is None:
            return "no 'Which look?' card was answered."
        picks = {
            t
            for label, t in evidence.offered
            if _has(message, label.lower()) or _named(message, t)
        }
        if picks == {theme_id}:
            return None
        return "the person's answer to the card does not pick this theme."
    if look_from == "you_choose":
        if any(_has(message, p) for p in YOU_CHOOSE_PHRASES):
            return None
        return "the person did not hand you the choice."
    if look_from == "background":
        if evidence.background:
            return None
        return "this is not background work: the person is here to choose."
    return "the person has not chosen this deck's look."


def _card_offer(output: Any) -> tuple[tuple[str, str], ...] | None:
    """``(label, theme id)`` of a stored tool output that is a deck-theme ``ask`` card."""
    try:
        payload = json.loads(output) if isinstance(output, str) else None
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("type") != "card":
        return None
    data = payload.get("data")
    options = (
        data.get("options") if payload.get("card") == "ask" and isinstance(data, dict) else None
    )
    offered = tuple(
        (str(o.get("label") or ""), str(o["preview"].get("id")))
        for o in options or ()
        if isinstance(o, dict)
        and isinstance(o.get("preview"), dict)
        and o["preview"].get("kind") == "deck-theme"
    )
    return offered or None


def _text(item: Mapping[str, Any]) -> str:
    """A stored message's typed text (its ``input_text`` / ``output_text`` parts)."""
    content = item.get("content")
    return "\n\n".join(
        b["text"]
        for b in (content if isinstance(content, list) else [])
        if isinstance(b, dict)
        and b.get("type") in ("input_text", "output_text")
        and isinstance(b.get("text"), str)
    ).strip()


def evidence_from_items(items: Sequence[Mapping[str, Any]]) -> tuple[str, tuple | None]:
    """The person's latest message and the deck-theme card just before it (items newest first).

    Only a card from :data:`_CARD_TOOLS` counts: another tool's output (shell, a file) is text
    the model controls and could imitate a card.
    """
    callers = {
        str(i.get("call_id")): str(i.get("name") or "")
        for i in items
        if i.get("type") == "function_call"
    }
    message: str | None = None
    for item in items:
        kind = item.get("type")
        if kind == "message" and item.get("role") == "user" and item.get("is_meta") is not True:
            text = _text(item)
            if not text or item.get("is_system_notice") is True or is_system_notice_text(text):
                continue
            if message is not None:
                break  # the person's message before: no card in between
            message = text
        elif (
            kind == "function_call_output"
            and message is not None
            and callers.get(str(item.get("call_id")), "").removeprefix(_MCP_PREFIX) in _CARD_TOOLS
        ):
            offered = _card_offer(item.get("output"))
            if offered:
                return message, offered
    return message or "", None


def declined_from_items(items: Sequence[Mapping[str, Any]]) -> set[str]:
    """Themes offered on an earlier look card in *items* that the person never picked or named."""
    callers = {
        str(i.get("call_id")): str(i.get("name") or "")
        for i in items
        if i.get("type") == "function_call"
    }
    offered: set[str] = set()
    said: list[str] = []
    for item in items:
        if item.get("type") == "function_call_output" and (
            callers.get(str(item.get("call_id")), "").removeprefix(_MCP_PREFIX) in _CARD_TOOLS
        ):
            offered.update(t for _, t in _card_offer(item.get("output")) or ())
        elif item.get("type") == "message" and item.get("role") == "user":
            said.append(_text(item).lower())
    chosen = {t for t in offered for text in said if _named(text, t)}
    return offered - chosen


async def _get(client: httpx.AsyncClient, url: str, **params: Any) -> Any:
    try:
        resp = await client.get(url, params=params or None, timeout=15.0)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


async def gather_evidence(ctx: HandlerCtx | None) -> LookEvidence | str:
    """Read the records a look is checked against, or say why they cannot be read."""
    if ctx is None or ctx.server_client is None or not ctx.conversation_id:
        return "the look cannot be checked here."
    client, session = ctx.server_client, ctx.conversation_id
    is_helper = background = False
    for _ in range(_MAX_HOPS):
        info = await _get(client, f"/v1/sessions/{session}")
        if not isinstance(info, dict) or not isinstance(info.get("kind"), str):
            return "the session could not be checked."
        labels = info.get("labels") if isinstance(info.get("labels"), dict) else {}
        background = background or any(key in labels for key in _BACKGROUND_LABELS)
        parent = info.get("parent_session_id")
        if info["kind"] != _SUB_AGENT:
            break
        if not isinstance(parent, str) or not parent:
            return "the Helper's chat could not be found."
        is_helper, session = True, parent
    else:
        return "the Helper's chat could not be found."
    page = await _get(client, f"/v1/sessions/{session}/items", order="desc", limit=ITEMS_SCANNED)
    items = page.get("data") if isinstance(page, dict) else None
    if not isinstance(items, list):
        return "the conversation could not be read."
    rows = [i for i in items if isinstance(i, dict)]
    message, offered = evidence_from_items(rows)
    return LookEvidence(
        is_helper=is_helper,
        background=background,
        message=message,
        offered=offered,
        chat=session,
        declined=frozenset(declined_from_items(rows)),
    )


@dataclass(frozen=True)
class LookCheck:
    """The gate's verdict: ``problem`` is ``None`` when the look is the person's choice."""

    problem: str | None
    message: str = ""
    in_helper: bool = False
    chat: str = ""
    declined: frozenset[str] = frozenset()


async def verify_look(ctx: HandlerCtx | None, look_from: object, theme_id: str) -> LookCheck:
    """Whether a new deck in *theme_id* may be built, read from the chat the person sees."""
    evidence = await gather_evidence(ctx)
    if isinstance(evidence, str):
        return LookCheck(evidence)
    problem = check_look(look_from, theme_id, evidence)
    return LookCheck(
        problem, evidence.message, evidence.is_helper, evidence.chat, evidence.declined
    )


#: What a deck is about -> the category of look that suits it. A topic word adds weight to every
#: theme of that category; the theme dictionary's own words (best for, mood, tagline) add more.
TOPICS: dict[str, tuple[str, ...]] = {
    "professional": (
        "finance",
        "financial",
        "sales",
        "revenue",
        "quarter",
        "quarterly",
        "budget",
        "board",
        "review",
        "report",
        "results",
        "earnings",
        "forecast",
        "metrics",
        "kpi",
        "kpis",
        "operations",
        "strategy",
        "audit",
        "compliance",
        "bank",
        "client",
    ),
    "editorial": (
        "travel",
        "trip",
        "culture",
        "food",
        "story",
        "history",
        "art",
        "city",
        "museum",
        "book",
        "writing",
        "festival",
        "wine",
        "journey",
        "heritage",
        "magazine",
    ),
    "bold": (
        "pitch",
        "launch",
        "startup",
        "investor",
        "investors",
        "product",
        "campaign",
        "marketing",
        "brand",
        "fundraising",
        "event",
        "kickoff",
        "announcement",
    ),
    "dark": (
        "tech",
        "technical",
        "engineering",
        "engineers",
        "developer",
        "developers",
        "api",
        "architecture",
        "platform",
        "security",
        "infrastructure",
        "software",
        "code",
        "ai",
    ),
}
_STOP = {"with", "from", "that", "this", "your", "deck", "slides", "make", "about", "into"}


def _words(text: str) -> set[str]:
    return set(re.findall(r"[a-z]{2,}", text.lower())) - _STOP


def _turn(seed: str, theme_id: str) -> str:
    """A stable tiebreak: the same request ranks equal themes the same way, others differently."""
    return hashlib.sha256(f"{seed}|{theme_id}".encode()).hexdigest()


def pick_three(hint: str, *, seed: str = "", avoid: frozenset[str] = frozenset()) -> list[str]:
    """Three themes from different categories that fit *hint* (the deck's title and request).

    Topic words favour a category (:data:`TOPICS`), the dictionary's ``best_for`` / ``mood`` /
    ``tagline`` words favour single themes, a named theme or mood counts most. Equal themes are
    ordered by a hash of *seed* (the chat and request), so offers vary without being random.
    Themes in *avoid* (offered before and not picked) come last.
    """
    words = _words(hint)
    named, moods = named_themes(hint), mood_themes(hint)
    favoured = {cat: 3 * len(words & set(keys)) for cat, keys in TOPICS.items()}
    if favoured["dark"]:  # tech also suits the monochrome themes
        favoured.update({t: 2 for t in kit.templates() if "mono" in t})

    def score(theme_id: str) -> int:
        t = kit.templates()[theme_id]
        about = _words(f"{t.best_for} {t.description} {t.tagline}")
        return (
            8 * (theme_id in named)
            + 4 * (theme_id in moods)
            + favoured.get(t.category, 0)
            + favoured.get(theme_id, 0)
            + len({w for w in words if len(w) > 3} & about)
        )

    ranked = sorted(kit.templates(), key=lambda t: (t in avoid, -score(t), _turn(seed or hint, t)))
    chosen: list[str] = []
    for theme_id in ranked:
        if kit.templates()[theme_id].category not in {kit.templates()[c].category for c in chosen}:
            chosen.append(theme_id)
        if len(chosen) == 3:
            break
    return chosen


def look_card(
    reason: str, hint: str, *, seed: str = "", avoid: frozenset[str] = frozenset()
) -> dict[str, Any]:
    """The "Which look?" card ``deck_new`` returns instead of a deck; it ends the turn."""
    templates = kit.templates()
    card = build_clarification(
        {
            "question": QUESTION,
            "options": [
                {"label": templates[t].name, "preview": {"kind": "deck-theme", "id": t}}
                for t in pick_three(hint, seed=seed, avoid=avoid)
            ],
        }
    )
    if "error" in card:  # the theme data itself is broken: say so rather than build
        return card
    card["written"] = False
    card["note"] = (
        f'Nothing was built: {reason} The person now sees the question "{QUESTION}" with 3 '
        "themes. Your turn ends here: write nothing more. Their pick arrives as their next "
        "message; build with it (look_from: picked)."
    )
    return card
