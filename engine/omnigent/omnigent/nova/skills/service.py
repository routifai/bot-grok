"""Domain logic for Nova's skills: ``SKILL.md`` validation, offering, saving.

Ports the TypeScript prototype's ``parseSkillMd`` / ``buildSkillMd``
(``packages/core/src/agent-skill.ts``) and the ``offer_skill`` / ``skill_create``
flow (``packages/adapters/src/muse/skill-offer.ts``,
``packages/adapters/src/skill-tools.ts``), keyed by the person (``NovaActor``)
instead of a bot. Unlike the TypeScript version, arbitrary frontmatter keys
are not round-tripped — Nova only ever reads/writes ``name`` and
``description``, so a real YAML parser (rather than a hand-rolled one) is
both simpler and sufficient.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

import yaml

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.nova._shared import NovaActor, cap_utf8, new_id
from omnigent.nova.skills.entities import OfferStatus, Skill, SkillOffer
from omnigent.nova.skills.store import SkillStore

NAME_MAX_CHARS = 80
DESCRIPTION_MAX_CHARS = 2_000
# Matches CreateAgentSkillInput / parseSkillMd's content bound in the
# TypeScript prototype (skill-tools.ts).
CONTENT_MAX_CHARS = 100_000

_FRONTMATTER_FENCE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)


@dataclass(frozen=True)
class ParsedSkill:
    """A ``SKILL.md`` document's frontmatter, split from its body.

    :param name: The skill's name, from the frontmatter.
    :param description: One line: when to use this skill.
    :param body: The markdown after the frontmatter fence.
    """

    name: str
    description: str
    body: str


def validate_fields(name: str, description: str) -> None:
    """Raise ``INVALID_INPUT`` if ``name``/``description`` break the bounds
    :func:`parse_skill_md` and :func:`build_skill_md` share.

    :param name: The skill's name.
    :param description: The skill's one-line description.
    :raises OmnigentError: ``INVALID_INPUT`` for an empty or overlong field.
    """
    if not name:
        raise OmnigentError("A skill needs a name.", code=ErrorCode.INVALID_INPUT)
    if not description:
        raise OmnigentError("A skill needs a description.", code=ErrorCode.INVALID_INPUT)
    if len(name) > NAME_MAX_CHARS:
        raise OmnigentError(
            f"Skill name must be at most {NAME_MAX_CHARS} characters.",
            code=ErrorCode.INVALID_INPUT,
        )
    if len(description) > DESCRIPTION_MAX_CHARS:
        raise OmnigentError(
            f"Skill description must be at most {DESCRIPTION_MAX_CHARS} characters.",
            code=ErrorCode.INVALID_INPUT,
        )


def parse_skill_md(content: str) -> ParsedSkill:
    """Parse a ``SKILL.md`` document: YAML frontmatter, then body.

    :param content: The full document text.
    :returns: The parsed name, description and body.
    :raises OmnigentError: ``INVALID_INPUT`` if there is no frontmatter
        fence, the frontmatter isn't a YAML mapping, or ``name``/
        ``description`` fail :func:`validate_fields`.
    """
    match = _FRONTMATTER_FENCE.match(content.lstrip("﻿"))
    if match is None:
        raise OmnigentError(
            "SKILL.md must start with YAML frontmatter (--- ... ---).",
            code=ErrorCode.INVALID_INPUT,
        )
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        raise OmnigentError(
            f"Invalid SKILL.md frontmatter: {exc}", code=ErrorCode.INVALID_INPUT
        ) from exc
    if not isinstance(frontmatter, dict):
        raise OmnigentError(
            "SKILL.md frontmatter must be a mapping.", code=ErrorCode.INVALID_INPUT
        )
    name = str(frontmatter.get("name") or "").strip()
    description = str(frontmatter.get("description") or "").strip()
    validate_fields(name, description)
    body = content[match.end() :].lstrip("\n")
    return ParsedSkill(name=name, description=description, body=body)


def build_skill_md(name: str, description: str, body: str) -> str:
    """Build a full ``SKILL.md`` document from its parts.

    :param name: The skill's name.
    :param description: One line: when to use this skill.
    :param body: The markdown steps, without frontmatter.
    :returns: The frontmatter fence followed by the (trimmed) body.
    :raises OmnigentError: ``INVALID_INPUT`` — see :func:`validate_fields`.
    """
    name = name.strip()
    description = description.strip()
    validate_fields(name, description)
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description}, sort_keys=False, allow_unicode=True
    )
    body_text = body.strip("\n")
    header = f"---\n{frontmatter}---\n"
    return f"{header}\n{body_text}\n" if body_text else header


def _check_content_size(content: str) -> None:
    """Raise ``INVALID_INPUT`` if *content* exceeds :data:`CONTENT_MAX_CHARS`."""
    if len(content) > CONTENT_MAX_CHARS:
        raise OmnigentError(
            f"Skill content must be at most {CONTENT_MAX_CHARS} characters.",
            code=ErrorCode.INVALID_INPUT,
        )


def render_skills_context(
    skills: Iterable[Skill], offers: Iterable[SkillOffer], max_bytes: int
) -> str:
    """Render saved skills and open offers into context text.

    :param skills: The person's saved skills, in any order.
    :param offers: The person's open offers, in any order.
    :param max_bytes: The UTF-8 budget for the returned text.
    :returns: The rendered text, capped to *max_bytes*; ``""`` when there is
        nothing to say.
    """
    lines: list[str] = []
    ordered_skills = sorted(skills, key=lambda skill: skill.name)
    if ordered_skills:
        lines.append("Saved skills (nova_load_skill with the name to use one):")
        lines.extend(f"- {skill.name}: {skill.description}" for skill in ordered_skills)
    names = sorted(offer.name for offer in offers)
    if names:
        lines.append(f"Already offered, awaiting an answer: {', '.join(names)}")
    return cap_utf8("\n".join(lines), max_bytes)


class SkillService:
    """Domain logic over a :class:`SkillStore`, scoped to one :class:`NovaActor` per call."""

    def __init__(self, store: SkillStore) -> None:
        """:param store: The backing store."""
        self._store = store

    # ── saved skills ─────────────────────────────────────────────────────

    def list_skills(self, actor: NovaActor) -> list[Skill]:
        """List the person's saved skills, alphabetical by name.

        :param actor: Whose skills to list.
        """
        return self._store.list_skills(actor)

    def get(self, actor: NovaActor, name: str) -> Skill | None:
        """Return one of the person's skills by exact name, or ``None``.

        :param actor: The requesting person.
        :param name: The skill's exact name.
        """
        return self._store.get_skill(actor, name)

    def delete(self, actor: NovaActor, name: str) -> bool:
        """Delete one of the person's skills by name.

        :param actor: The requesting owner.
        :param name: The skill's exact name.
        :returns: ``True`` if removed, ``False`` if not found / not owned.
        """
        return self._store.delete_skill(actor, name)

    def save(
        self,
        actor: NovaActor,
        *,
        name: str | None = None,
        description: str | None = None,
        body: str | None = None,
        content: str | None = None,
    ) -> Skill:
        """Save a skill directly (``nova_save_skill``): no offer, no card.

        Accepts either a full ``content`` document (when the person pasted
        their own ``SKILL.md``) or ``name``/``description`` with an optional
        ``body`` (when Nova is writing one from the steps it just did) — the
        same two input shapes as the TypeScript prototype's
        ``skillCreateFromTool``.

        :param actor: Whose skill this is.
        :param name: The skill's name, when not passing ``content``.
        :param description: One-line description, when not passing ``content``.
        :param body: The markdown steps, when not passing ``content``.
        :param content: A complete ``SKILL.md`` document, frontmatter included.
        :returns: The saved :class:`Skill`.
        :raises OmnigentError: ``INVALID_INPUT`` for a malformed/oversized
            document or missing fields; ``ALREADY_EXISTS`` if the person
            already has a skill with this name.
        """
        parsed = self._resolve(name=name, description=description, body=body, content=content)
        full_content = build_skill_md(parsed.name, parsed.description, parsed.body)
        _check_content_size(full_content)
        if self._store.get_skill(actor, parsed.name) is not None:
            raise OmnigentError(
                f'A skill named "{parsed.name}" already exists.', code=ErrorCode.ALREADY_EXISTS
            )
        return self._store.create_skill(
            new_id(),
            actor,
            name=parsed.name,
            description=parsed.description,
            content=full_content,
        )

    @staticmethod
    def _resolve(
        *,
        name: str | None,
        description: str | None,
        body: str | None,
        content: str | None,
    ) -> ParsedSkill:
        """Resolve either input shape ``save`` accepts into one :class:`ParsedSkill`."""
        if content and content.strip():
            return parse_skill_md(content)
        if name and description:
            return ParsedSkill(name=name.strip(), description=description.strip(), body=body or "")
        raise OmnigentError(
            "Provide name and description (and optional body), or a full SKILL.md document.",
            code=ErrorCode.INVALID_INPUT,
        )

    # ── offers ───────────────────────────────────────────────────────────

    def open_offers(self, actor: NovaActor) -> list[SkillOffer]:
        """List the person's open offers, newest first.

        :param actor: Whose offers to list.
        """
        return self._store.list_open_offers(actor)

    def offer(
        self, actor: NovaActor, *, name: str, description: str, body: str = ""
    ) -> SkillOffer:
        """Offer to save a skill (``nova_offer_skill``): posts a Save / Not now card.

        Refuses a duplicate of a name already saved, already offered and
        open, or already declined — so a declined offer is never repeated.

        :param actor: Who is being offered the skill.
        :param name: The proposed skill's name.
        :param description: One-line description of when to use it.
        :param body: The markdown steps.
        :returns: The created, open :class:`SkillOffer`.
        :raises OmnigentError: ``INVALID_INPUT`` for a malformed/oversized
            document; ``ALREADY_EXISTS`` if this name is already saved,
            already pending, or was already declined.
        """
        clean_name = (name or "").strip()
        clean_description = (description or "").strip()
        validate_fields(clean_name, clean_description)
        content = build_skill_md(clean_name, clean_description, body)
        _check_content_size(content)

        if self._store.get_skill(actor, clean_name) is not None:
            raise OmnigentError(
                f'A skill named "{clean_name}" is already saved.', code=ErrorCode.ALREADY_EXISTS
            )
        blocking = self._store.find_blocking_offer(actor, clean_name)
        if blocking is not None:
            reason = (
                "already waiting on your answer"
                if blocking.status is OfferStatus.OPEN
                else "already declined"
            )
            raise OmnigentError(
                f'An offer named "{clean_name}" is {reason}.', code=ErrorCode.ALREADY_EXISTS
            )
        return self._store.create_offer(
            new_id(), actor, name=clean_name, description=clean_description, content=content
        )

    def accept_offer(self, actor: NovaActor, offer_id: str) -> Skill:
        """Accept an open offer: saves the skill, marks the offer answered.

        :param actor: The person answering; also the offer's required owner.
        :param offer_id: The offer being accepted.
        :returns: The saved :class:`Skill`.
        :raises OmnigentError: ``NOT_FOUND`` if no such offer exists for this
            person; ``CONFLICT`` if it is no longer open.
        """
        offer = self._require_open_offer(actor, offer_id)
        decided = self._store.decide_offer(actor, offer_id, status=OfferStatus.SAVED)
        if decided is None:
            raise OmnigentError("This offer was already answered", code=ErrorCode.CONFLICT)

        existing = self._store.get_skill(actor, offer.name)
        if existing is not None:
            # A race with a direct nova_save_skill call landed first; the
            # offer is still marked answered — mirrors the TypeScript
            # prototype's tolerance of an "already exists" skill_create
            # failure at this same point (apps/api/src/muse-asks.ts).
            return existing
        return self._store.create_skill(
            new_id(), actor, name=offer.name, description=offer.description, content=offer.content
        )

    def dismiss_offer(self, actor: NovaActor, offer_id: str) -> SkillOffer:
        """Decline an open offer. Nothing is saved; the name won't be re-offered.

        :param actor: The person answering; also the offer's required owner.
        :param offer_id: The offer being declined.
        :returns: The now-dismissed :class:`SkillOffer`.
        :raises OmnigentError: ``NOT_FOUND`` if no such offer exists for this
            person; ``CONFLICT`` if it is no longer open.
        """
        self._require_open_offer(actor, offer_id)
        decided = self._store.decide_offer(actor, offer_id, status=OfferStatus.DISMISSED)
        if decided is None:
            raise OmnigentError("This offer was already answered", code=ErrorCode.CONFLICT)
        return decided

    def _require_open_offer(self, actor: NovaActor, offer_id: str) -> SkillOffer:
        """Return the actor's open offer, or raise ``NOT_FOUND``/``CONFLICT``."""
        offer = self._store.get_offer(actor, offer_id)
        if offer is None:
            raise OmnigentError("Offer not found", code=ErrorCode.NOT_FOUND)
        if offer.status is not OfferStatus.OPEN:
            raise OmnigentError("This offer was already answered", code=ErrorCode.CONFLICT)
        return offer
