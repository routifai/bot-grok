"""Server-side gates for ``nova_offer_skill``: rules enforced in code, not only the prompt.

A bad offer taught the product owner nothing: Nova called ``nova_offer_skill``
after a turn where a chart tool had errored eight times, for a one-off
research question — the offer was neither about work that succeeded nor a
repeatable procedure. These are cheap, pure heuristics (no LLM call);
:class:`~omnigent.nova.skills.service.SkillService.offer` applies them and
turns each failing check into a short, specific refusal the model can act on.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes import EpisodeStore, rank_episodes
from omnigent.nova.skills.entities import Skill

if TYPE_CHECKING:
    from omnigent.entities.conversation import ConversationItem

# ── rule 1: never after a failed turn ───────────────────────────────────────

FAILURE_STREAK_LAST_N = 3
"""Refuse when this many of the turn's most recent tool-call results all errored."""

TURN_LOOKBACK_ITEMS = 200
"""How far back to scan this turn's conversation items — matches
``episodes.observer``'s own lookback for the same "walk back to the
triggering user message" scan."""


def _is_error_output(output: str) -> bool:
    """Whether a tool's output string looks like a failure.

    Covers the conventions actually in use for a ``function_call_output``:
    every built-in tool in this codebase (see ``skills/tools.py``,
    ``episodes/tools.py``) returns JSON with a truthy top-level ``"error"``
    key on failure; an MCP tool call that errors without an image result
    comes back as the plain string ``"Error: ..."``
    (``omnigent.tools.mcp._format_call_result``), and one with an image
    result comes back as the ``isError`` envelope
    (``omnigent.runtime.mcp_tool_result.encode_mcp_image_result``). This is a
    heuristic over those conventions, not a protocol guarantee — a tool
    outside them is treated as having succeeded.

    :param output: The raw ``function_call_output`` string.
    :returns: ``True`` if *output* looks like an error by any of the above.
    """
    try:
        parsed = json.loads(output)
    except (TypeError, ValueError):
        return output.startswith("Error: ")
    if not isinstance(parsed, dict):
        return False
    return bool(parsed.get("error")) or parsed.get("isError") is True


def turn_is_failing(results: Sequence[bool]) -> bool:
    """Whether this turn's tool-call results look like a failing turn.

    :param results: Oldest-first outcomes of this turn's tool calls; ``True``
        means that call's output was an error.
    :returns: ``True`` if more calls failed than succeeded, or the last
        :data:`FAILURE_STREAK_LAST_N` all failed.
    """
    if not results:
        return False
    failed = sum(results)
    if failed > len(results) - failed:
        return True
    tail = results[-FAILURE_STREAK_LAST_N:]
    return len(tail) == FAILURE_STREAK_LAST_N and all(tail)


@dataclass(frozen=True)
class TurnSignals:
    """What :func:`read_turn_signals` extracts from this turn's items.

    :param tool_results: Oldest-first; ``True`` means that tool call's output
        was an error (see :func:`_is_error_output`).
    :param latest_user_message: The message that started this turn, or ``""``
        if none was found within the lookback window.
    """

    tool_results: tuple[bool, ...]
    latest_user_message: str


def read_turn_signals(items_newest_first: Sequence[ConversationItem]) -> TurnSignals:
    """Walk this turn's items (newest first) back to the triggering user message.

    Mirrors ``episodes.observer._turn_fields``'s walk, but collects tool-call
    outputs and their apparent success instead of the assistant reply.

    :param items_newest_first: One page of conversation items, newest first
        (e.g. ``conversation_store.list_items(..., order="desc")``).
    :returns: The extracted :class:`TurnSignals`.
    """
    from omnigent.entities import FunctionCallOutputData, MessageData

    outputs_newest_first: list[str] = []
    latest_user_message = ""
    for item in items_newest_first:
        if item.type == "message" and isinstance(item.data, MessageData):
            if item.data.role == "user":
                latest_user_message = _message_text(item.data.content)
                break
        elif item.type == "function_call_output" and isinstance(item.data, FunctionCallOutputData):
            outputs_newest_first.append(item.data.output)

    results = tuple(_is_error_output(output) for output in reversed(outputs_newest_first))
    return TurnSignals(tool_results=results, latest_user_message=latest_user_message)


def _message_text(content: list[dict[str, object]]) -> str:
    """Join a message's text content blocks (same shape as ``observer._message_text``)."""
    parts = [str(text) for block in content if (text := block.get("text"))]
    return "\n".join(parts)


# ── rule 2: a procedure, not a topic ────────────────────────────────────────

MIN_PROCEDURE_STEPS = 3
"""A proposed skill body needs at least this many steps to be a procedure."""

_STEPS_HEADING_RE = re.compile(r"(?im)^#{0,6}\s*(steps|procedure)\b.*$")
_STEP_LINE_RE = re.compile(r"(?m)^\s*(?:[-*+]|\d+[.)])\s+\S")
_WHEN_TO_USE_RE = re.compile(r"(?im)when to use")


def has_procedure_shape(body: str) -> bool:
    """Whether ``body`` reads as concrete steps, not a restated topic.

    Requires a "When to use" line, plus a "Steps"/"Procedure" heading
    followed by at least :data:`MIN_PROCEDURE_STEPS` numbered or bulleted
    lines — the same shape ``build_skill_md`` already produces.

    :param body: The proposed skill's markdown body (no frontmatter).
    :returns: ``True`` if the body looks like a procedure.
    """
    if not _WHEN_TO_USE_RE.search(body):
        return False
    heading = _STEPS_HEADING_RE.search(body)
    if heading is None:
        return False
    steps_in_scope = _STEP_LINE_RE.findall(body[heading.end() :])
    return len(steps_in_scope) >= MIN_PROCEDURE_STEPS


# ── rule 3: evidence of reuse ────────────────────────────────────────────────

REUSE_LOOKBACK_EPISODES = 200
"""How many of the person's most recent episodes :func:`has_reuse_evidence` searches."""

REUSE_MATCH_THRESHOLD = 0.5
"""Fraction of the proposed name+description's significant words an episode's
title+summary must share to count as a match."""

REUSE_MIN_MATCHES = 2
"""How many matching past episodes constitute evidence the person has done
similar work before."""

_WORD_RE = re.compile(r"[a-z0-9]+")


def _significant_words(text: str) -> set[str]:
    """Lowercased, 3+ char word set.

    A much simpler tokenizer than ``episodes.service``'s (no
    stopwords/stemming) — good enough for a similarity ratio, not for
    ranking, so it doesn't need that module's internals.
    """
    return {word for word in _WORD_RE.findall(text.lower()) if len(word) >= 3}


def has_reuse_evidence(
    actor: NovaActor, name: str, description: str, *, episode_store: EpisodeStore
) -> bool:
    """Whether the person's episode history shows they've done this before.

    :param actor: Whose episodes to search.
    :param name: The proposed skill's name.
    :param description: The proposed skill's one-line description.
    :param episode_store: Where to read the person's recent episodes from.
    :returns: ``True`` if at least :data:`REUSE_MIN_MATCHES` of the person's
        last :data:`REUSE_LOOKBACK_EPISODES` episodes rank against ``name`` +
        ``description`` (via :func:`~omnigent.nova.episodes.rank_episodes`)
        and share at least :data:`REUSE_MATCH_THRESHOLD` of its significant
        words.
    """
    query = f"{name} {description}"
    query_words = _significant_words(query)
    if not query_words:
        return False
    episodes = episode_store.list_recent(actor=actor, limit=REUSE_LOOKBACK_EPISODES)
    ranked = rank_episodes(query, episodes, limit=REUSE_LOOKBACK_EPISODES)
    matches = 0
    for episode in ranked:
        episode_words = _significant_words(f"{episode.title} {episode.summary}")
        if not episode_words:
            continue
        overlap = len(query_words & episode_words) / len(query_words)
        if overlap >= REUSE_MATCH_THRESHOLD:
            matches += 1
            if matches >= REUSE_MIN_MATCHES:
                return True
    return False


_INSTRUCTION_CUES: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\bremember how\b",
        r"\bremember (this|that)\b",
        r"\bsave (this|that) as\b",
        r"\bnext time\b",
        r"\balways\b",
        r"\bno,?\s+do it\b",
        r"\bdon'?t\b.*\binstead\b",
        r"\binstead\b",
        r"\bteach you\b",
        r"\blearn how\b",
    )
)
"""Phrases that mark an actual instruction or correction, e.g. "remember
how", "save this", "next time", "always", "no, do it like...",
"don't...instead" — see :func:`has_instruction_or_correction_cue`."""


def has_instruction_or_correction_cue(latest_user_message: str) -> bool:
    """Whether the turn's latest user message actually asked for this.

    Backs the ``reason="asked"``/``reason="corrected"`` bypass in rule 3:
    an unverified ``reason`` argument from the model is not itself evidence.

    :param latest_user_message: The message that started this turn.
    :returns: ``True`` if it contains an instruction or correction cue.
    """
    return any(cue.search(latest_user_message) for cue in _INSTRUCTION_CUES)


# ── rule 4: improve before creating ──────────────────────────────────────────

SIMILARITY_THRESHOLD = 0.6
"""Jaccard word overlap above which a proposed skill counts as "clearly
similar" to an already-saved one, and gets redirected to an update offer."""


def find_similar_skill(name: str, description: str, skills: Sequence[Skill]) -> Skill | None:
    """The already-saved skill this proposal most resembles, if any is close enough.

    :param name: The proposed skill's name.
    :param description: The proposed skill's one-line description.
    :param skills: The person's saved skills.
    :returns: The best-matching :class:`Skill` scoring at least
        :data:`SIMILARITY_THRESHOLD`, or ``None``.
    """
    proposed_words = _significant_words(f"{name} {description}")
    if not proposed_words:
        return None
    best: Skill | None = None
    best_score = 0.0
    for skill in skills:
        existing_words = _significant_words(f"{skill.name} {skill.description}")
        if not existing_words:
            continue
        overlap = len(proposed_words & existing_words) / len(proposed_words | existing_words)
        if overlap > best_score:
            best_score = overlap
            best = skill
    return best if best is not None and best_score >= SIMILARITY_THRESHOLD else None
