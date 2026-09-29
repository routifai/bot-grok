"""Domain types for Nova's skills: what it learns to repeat, and offers to save one."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class OfferStatus(StrEnum):
    """Lifecycle of a skill offer.

    :cvar OPEN: Waiting on the person's Save / Not now.
    :cvar SAVED: The person chose Save; the skill now exists.
    :cvar DISMISSED: The person chose Not now; never re-offered by name.
    """

    OPEN = "open"
    SAVED = "saved"
    DISMISSED = "dismissed"


@dataclass(frozen=True)
class Skill:
    """One repeatable task Nova learned, saved for a person.

    :param id: Opaque 32-char hex id.
    :param user_id: The person the skill belongs to (a :class:`NovaActor`'s
        ``user_id``).
    :param workspace_id: Omnigent workspace the skill lives in.
    :param name: Short name, e.g. ``"Weekly status report"``. Unique per person.
    :param description: One line: when to use this skill.
    :param content: The full ``SKILL.md`` text (YAML frontmatter + steps).
    :param created_at: Unix epoch seconds when first saved.
    :param updated_at: Unix epoch seconds of the last save.
    """

    id: str
    user_id: str
    workspace_id: int
    name: str
    description: str
    content: str
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class SkillOffer:
    """A skill Nova proposed saving, waiting on the person's Save / Not now.

    :param id: Opaque 32-char hex id.
    :param user_id: The person being offered the skill.
    :param workspace_id: Omnigent workspace the offer lives in.
    :param name: The proposed skill's name.
    :param description: One line: when to use this skill.
    :param content: The full ``SKILL.md`` text Nova proposes saving.
    :param status: Open, saved, or dismissed.
    :param created_at: Unix epoch seconds when offered.
    :param decided_at: Unix epoch seconds the person decided, or ``None``
        while open.
    """

    id: str
    user_id: str
    workspace_id: int
    name: str
    description: str
    content: str
    status: OfferStatus
    created_at: int
    decided_at: int | None
