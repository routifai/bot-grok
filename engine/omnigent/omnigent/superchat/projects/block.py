"""The per-turn Project list the runner adds to a Super Chat turn."""

from __future__ import annotations

from pathlib import Path

from omnigent.superchat.projects.card import (
    ProjectCard,
    is_slug,
    list_cards,
    projects_root,
    read_card,
)

#: Most Projects listed in a turn (the most recently modified); the open one is always listed.
MAX_LISTED = 15
_MAX_ALIASES = 6
_MAX_SUMMARY_CHARS = 160


def open_project_slug(workspace: Path | None) -> str | None:
    """The slug of the Project ``workspace`` is in (or under), or ``None`` at the root."""
    if workspace is None:
        return None
    try:
        relative = workspace.resolve().relative_to(projects_root().resolve())
    except ValueError:
        return None
    slug = relative.parts[0] if relative.parts else None
    return slug if is_slug(slug) else None


def _line(card: ProjectCard, *, is_open: bool) -> str:
    text = f"- {card.slug}: {card.name}"
    if card.aliases:
        text += f" (also: {', '.join(card.aliases[:_MAX_ALIASES])})"
    if card.summary:
        summary = card.summary
        if len(summary) > _MAX_SUMMARY_CHARS:
            summary = summary[: _MAX_SUMMARY_CHARS - 1].rstrip() + "…"
        text += f". {summary}"
    return text + (" [open now]" if is_open else "")


def projects_block(workspace: Path | None) -> str | None:
    """The Project list for one turn, or ``None`` when there are no Projects.

    :param workspace: The session's current working directory (marks the open Project).
    """
    open_slug = open_project_slug(workspace)
    cards = list_cards(MAX_LISTED)
    if open_slug is not None and all(c.slug != open_slug for c in cards):
        open_card = read_card(open_slug)
        if open_card is not None:
            cards.append(open_card)
    if not cards:
        return None
    lines = [_line(card, is_open=card.slug == open_slug) for card in cards]
    return (
        "[Projects (folders under ~/workspace/projects/). When this conversation is about one, "
        "call open_project with its slug before working in it.\n" + "\n".join(lines) + "]"
    )
