"""The skills store interface: saved skills and pending Save / Not now offers."""

from __future__ import annotations

from abc import ABC, abstractmethod

from omnigent.nova._shared import NovaActor
from omnigent.nova.skills.entities import OfferStatus, Skill, SkillOffer


class SkillStore(ABC):
    """Abstract base for Nova's skills persistence.

    Every method is scoped by the actor's ``(workspace_id, user_id)`` — a
    person only ever sees and mutates their own skills and offers.
    """

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: Backend-specific storage URI, e.g.
            ``"sqlite:///omnigent.db"``.
        """
        self.storage_location = storage_location

    # ── skills ───────────────────────────────────────────────────────────

    @abstractmethod
    def list_skills(self, actor: NovaActor) -> list[Skill]:
        """Return the person's saved skills, alphabetical by name.

        :param actor: Whose skills to list.
        :returns: The person's skills; empty when they have saved none.
        """

    @abstractmethod
    def get_skill(self, actor: NovaActor, name: str) -> Skill | None:
        """Return one of the person's skills by exact name, or ``None``.

        :param actor: The requesting person; a skill owned by someone else
            is treated as not found.
        :param name: The skill's exact name.
        :returns: The :class:`Skill` if found and owned, else ``None``.
        """

    @abstractmethod
    def create_skill(
        self, skill_id: str, actor: NovaActor, *, name: str, description: str, content: str
    ) -> Skill:
        """Insert a new skill. Callers dedupe by name first (see ``SkillService``).

        :param skill_id: Pre-generated unique skill id.
        :param actor: Whose skill this is.
        :param name: The skill's name.
        :param description: One-line description of when to use it.
        :param content: The full ``SKILL.md`` text (frontmatter + body).
        :returns: The created :class:`Skill`.
        """

    @abstractmethod
    def delete_skill(self, actor: NovaActor, name: str) -> bool:
        """Delete one of the person's skills by name. Idempotent.

        :param actor: The requesting owner; a skill owned by someone else
            is treated as not found.
        :param name: The skill's exact name.
        :returns: ``True`` if removed, ``False`` if not found / not owned.
        """

    # ── offers ───────────────────────────────────────────────────────────

    @abstractmethod
    def list_open_offers(self, actor: NovaActor) -> list[SkillOffer]:
        """Return the person's open offers, newest first.

        :param actor: Whose offers to list.
        """

    @abstractmethod
    def get_offer(self, actor: NovaActor, offer_id: str) -> SkillOffer | None:
        """Return one of the person's offers by id, or ``None`` if not found/owned.

        :param actor: The requesting person.
        :param offer_id: The offer to fetch.
        """

    @abstractmethod
    def find_blocking_offer(self, actor: NovaActor, name: str) -> SkillOffer | None:
        """Find an existing open or dismissed offer with this name, if any.

        Backs the "never repeat a declined offer" rule: an offer for a name
        that was already declined, or is already pending, blocks a new one.

        :param actor: Whose offers to search.
        :param name: The proposed skill's name.
        :returns: The blocking :class:`SkillOffer`, or ``None``.
        """

    @abstractmethod
    def create_offer(
        self, offer_id: str, actor: NovaActor, *, name: str, description: str, content: str
    ) -> SkillOffer:
        """Insert a new open offer. Callers check :meth:`find_blocking_offer` first.

        :param offer_id: Pre-generated unique offer id.
        :param actor: Who is being offered the skill.
        :param name: The proposed skill's name.
        :param description: One-line description of when to use it.
        :param content: The full ``SKILL.md`` text.
        :returns: The created :class:`SkillOffer`, ``status=OPEN``.
        """

    @abstractmethod
    def decide_offer(
        self, actor: NovaActor, offer_id: str, *, status: OfferStatus
    ) -> SkillOffer | None:
        """Move an open offer to ``SAVED`` or ``DISMISSED``.

        :param actor: The requesting owner; an offer owned by someone else
            is treated as not found.
        :param offer_id: The offer to decide.
        :param status: The terminal status to set (``SAVED``/``DISMISSED``).
        :returns: The updated offer, or ``None`` if not found, not owned, or
            no longer open.
        """
