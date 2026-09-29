"""Tests for ``SKILL.md`` validation and :class:`SkillService` domain logic.

The parsing/building tests port the essential cases from the TypeScript
prototype's ``agent-skill.test.ts`` (requires name/description, rejects an
overlong name, requires a frontmatter fence, round-trips through
``build_skill_md``/``parse_skill_md``); the rest exercise the offer → accept /
dismiss lifecycle and the no-repeat rule against a real SQLite-backed store.

Every ``offer()`` call here must clear the gate in ``gate.py`` (see
``test_gate.py`` for that gate exercised on its own): a real procedure
body (``VALID_BODY``) and either ``ASKED_REASON``/``ASKED_MESSAGE`` (an
explicit "asked" cue, so no episode store is needed) or seeded episode
evidence.
"""

from __future__ import annotations

import pytest

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.sqlalchemy_store import SqlAlchemyEpisodeStore
from omnigent.nova.skills.entities import OfferKind, OfferStatus
from omnigent.nova.skills.service import (
    SkillService,
    build_skill_md,
    parse_skill_md,
)
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)

VALID_BODY = (
    "## Steps\n"
    "1. Do the first thing.\n"
    "2. Do the second thing.\n"
    "3. Do the third thing.\n\n"
    "When to use: whenever this task comes up again.\n"
)
# Bypasses gate rule 3 (evidence of reuse) without needing an episode store:
# reason="asked" + a message containing an instruction cue.
ASKED_REASON = "asked"
ASKED_MESSAGE = "Please remember how to do this next time."


@pytest.fixture()
def service(db_uri: str) -> SkillService:
    return SkillService(SqlAlchemySkillStore(db_uri))


def _seed_episode(
    store: SqlAlchemyEpisodeStore, *, title: str, summary: str, created_at: int
) -> Episode:
    return store.upsert(
        actor=ACTOR,
        session_id="s",
        turn_id=f"t-{title}",
        title=title,
        summary=summary,
        tools=("web_search",),
        links=(),
        created_at=created_at,
    )


# ── parse_skill_md / build_skill_md ─────────────────────────────────────────


def test_parse_requires_frontmatter_fence() -> None:
    with pytest.raises(OmnigentError):
        parse_skill_md("no frontmatter here")


def test_parse_requires_description() -> None:
    with pytest.raises(OmnigentError):
        parse_skill_md("---\nname: x\n---\nbody")


def test_parse_requires_name() -> None:
    with pytest.raises(OmnigentError):
        parse_skill_md("---\ndescription: x\n---\nbody")


def test_parse_rejects_overlong_name() -> None:
    name = "n" * 81
    with pytest.raises(OmnigentError):
        parse_skill_md(f"---\nname: {name}\ndescription: ok\n---\nbody")


def test_parse_rejects_overlong_description() -> None:
    description = "d" * 2001
    with pytest.raises(OmnigentError):
        parse_skill_md(f"---\nname: ok\ndescription: {description}\n---\nbody")


def test_parse_extracts_name_description_and_body() -> None:
    doc = (
        "---\nname: Daily standup\ndescription: Prepare a standup update.\n---\n\n"
        "# Steps\n1. Do it.\n"
    )
    parsed = parse_skill_md(doc)
    assert parsed.name == "Daily standup"
    assert parsed.description == "Prepare a standup update."
    assert "# Steps" in parsed.body


def test_build_then_parse_round_trips() -> None:
    content = build_skill_md("Daily standup", "Prepare a standup update.", "# Steps\n1. Do it.\n")
    parsed = parse_skill_md(content)
    assert parsed.name == "Daily standup"
    assert parsed.description == "Prepare a standup update."
    assert "# Steps" in parsed.body


def test_build_rejects_empty_name() -> None:
    with pytest.raises(OmnigentError):
        build_skill_md("", "description", "body")


def test_build_rejects_overlong_description() -> None:
    with pytest.raises(OmnigentError):
        build_skill_md("name", "d" * 2001, "body")


# ── offer / accept / dismiss ─────────────────────────────────────────────────


def test_offer_creates_open_offer(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="Summarize the week.",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    assert offer.status is OfferStatus.OPEN
    assert offer.name == "Weekly report"


def test_offer_rejects_duplicate_open_offer(service: SkillService) -> None:
    service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Weekly report",
            description="d",
            body=VALID_BODY,
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_offer_never_repeats_a_declined_offer(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    service.dismiss_offer(ACTOR, offer.id)
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Weekly report",
            description="d",
            body=VALID_BODY,
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_offer_rejects_a_name_already_saved_when_not_similar_enough(service: SkillService) -> None:
    # Same exact name, but different-enough descriptions that gate.find_similar_skill
    # doesn't redirect this to an update offer (see test_offer_redirects_to_update_*
    # below for the case where it does).
    service.save(
        ACTOR, name="Weekly report", description="Summarize engineering progress.", body="b"
    )
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Weekly report",
            description="List support tickets.",
            body=VALID_BODY,
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_offer_refuses_after_a_failed_turn(service: SkillService) -> None:
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Weekly report",
            description="d",
            body=VALID_BODY,
            turn_failed=True,
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_offer_refuses_a_body_that_is_not_a_procedure(service: SkillService) -> None:
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Weekly report",
            description="d",
            body="Just a restated topic, no steps here.",
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_offer_refuses_without_reuse_evidence_or_a_qualifying_reason(
    service: SkillService, db_uri: str
) -> None:
    empty_episodes = SqlAlchemyEpisodeStore(db_uri)
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Canadian credit card comparison",
            description="Compare Canadian credit cards by rewards.",
            body=VALID_BODY,
            episode_store=empty_episodes,
        )


def test_offer_refuses_reason_asked_without_an_actual_cue(
    service: SkillService, db_uri: str
) -> None:
    # reason="asked" alone isn't evidence: the latest user message must
    # actually contain an instruction/correction cue.
    empty_episodes = SqlAlchemyEpisodeStore(db_uri)
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name="Canadian credit card comparison",
            description="Compare Canadian credit cards by rewards.",
            body=VALID_BODY,
            reason="asked",
            latest_user_message="what's the best credit card in Canada?",
            episode_store=empty_episodes,
        )


def test_offer_allows_with_matching_episode_history(service: SkillService, db_uri: str) -> None:
    episode_store = SqlAlchemyEpisodeStore(db_uri)
    _seed_episode(
        episode_store,
        title="Compare Canadian credit cards",
        summary="Found the best cashback card.",
        created_at=1_700_000_000,
    )
    _seed_episode(
        episode_store,
        title="Canadian credit card comparison",
        summary="Ranked cards by rewards.",
        created_at=1_700_000_100,
    )
    offer = service.offer(
        ACTOR,
        name="Canadian credit card comparison",
        description="Compare Canadian credit cards by rewards.",
        body=VALID_BODY,
        episode_store=episode_store,
    )
    assert offer.offer_kind is OfferKind.NEW


def test_offer_redirects_to_update_when_a_similar_skill_is_already_saved(
    service: SkillService,
) -> None:
    service.save(
        ACTOR,
        name="Weekly report",
        description="Summarize the week's engineering progress.",
        body="Old steps.",
    )
    offer = service.offer(
        ACTOR,
        name="Weekly status report",
        description="Summarize the week's engineering progress for the team.",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    assert offer.offer_kind is OfferKind.UPDATE
    assert offer.target_skill == "Weekly report"
    assert offer.name == "Weekly report"


def test_offer_rejects_a_duplicate_pending_update_offer(service: SkillService) -> None:
    service.save(
        ACTOR,
        name="Weekly report",
        description="Summarize the week's engineering progress.",
        body="Old steps.",
    )
    proposed_name = "Weekly status report"
    proposed_description = "Summarize the week's engineering progress for the team."
    service.offer(
        ACTOR,
        name=proposed_name,
        description=proposed_description,
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    with pytest.raises(OmnigentError):
        service.offer(
            ACTOR,
            name=proposed_name,
            description=proposed_description,
            body=VALID_BODY,
            reason=ASKED_REASON,
            latest_user_message=ASKED_MESSAGE,
        )


def test_accept_update_offer_replaces_body_but_keeps_the_original_name(
    service: SkillService,
) -> None:
    original = service.save(
        ACTOR,
        name="Weekly report",
        description="Summarize the week's engineering progress.",
        body="Old steps.",
    )
    offer = service.offer(
        ACTOR,
        name="Weekly status report",
        description="Summarize the week's engineering progress for the team.",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    assert offer.offer_kind is OfferKind.UPDATE

    updated = service.accept_offer(ACTOR, offer.id)

    assert updated.id == original.id
    assert updated.name == "Weekly report"
    assert "Do the first thing" in updated.content
    assert len(service.list_skills(ACTOR)) == 1


def test_accept_offer_saves_the_skill(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    skill = service.accept_offer(ACTOR, offer.id)
    assert skill.name == "Weekly report"
    assert service.get(ACTOR, "Weekly report") is not None
    assert service.open_offers(ACTOR) == []


def test_accept_offer_is_idempotent_against_a_racing_save(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    # Simulates a nova_save_skill call landing between offer and accept.
    service.save(ACTOR, name="Weekly report", description="d", body="b")
    skill = service.accept_offer(ACTOR, offer.id)
    assert skill.name == "Weekly report"
    assert len(service.list_skills(ACTOR)) == 1


def test_accept_unknown_offer_raises(service: SkillService) -> None:
    with pytest.raises(OmnigentError):
        service.accept_offer(ACTOR, "deadbeefdeadbeefdeadbeefdeadbeef")


def test_accept_already_answered_offer_raises(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    service.accept_offer(ACTOR, offer.id)
    with pytest.raises(OmnigentError):
        service.accept_offer(ACTOR, offer.id)


def test_dismiss_offer_saves_nothing(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    dismissed = service.dismiss_offer(ACTOR, offer.id)
    assert dismissed.status is OfferStatus.DISMISSED
    assert service.get(ACTOR, "Weekly report") is None


def test_dismiss_already_answered_offer_raises(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    service.dismiss_offer(ACTOR, offer.id)
    with pytest.raises(OmnigentError):
        service.dismiss_offer(ACTOR, offer.id)


def test_offers_are_scoped_to_owner(service: SkillService) -> None:
    other = NovaActor(user_id="bob@example.com", workspace_id=0)
    offer = service.offer(
        ACTOR,
        name="Weekly report",
        description="d",
        body=VALID_BODY,
        reason=ASKED_REASON,
        latest_user_message=ASKED_MESSAGE,
    )
    with pytest.raises(OmnigentError):
        service.accept_offer(other, offer.id)


# ── save ─────────────────────────────────────────────────────────────────────


def test_save_with_name_description_body(service: SkillService) -> None:
    skill = service.save(ACTOR, name="Weekly report", description="d", body="b")
    assert skill.name == "Weekly report"
    assert "b" in skill.content


def test_save_with_full_content(service: SkillService) -> None:
    content = build_skill_md("Weekly report", "d", "b")
    skill = service.save(ACTOR, content=content)
    assert skill.name == "Weekly report"


def test_save_rejects_duplicate_name(service: SkillService) -> None:
    service.save(ACTOR, name="Weekly report", description="d", body="b")
    with pytest.raises(OmnigentError):
        service.save(ACTOR, name="Weekly report", description="d2", body="b2")


def test_save_requires_name_and_description_or_content(service: SkillService) -> None:
    with pytest.raises(OmnigentError):
        service.save(ACTOR)


# ── list / get / delete ──────────────────────────────────────────────────────


def test_list_is_alphabetical(service: SkillService) -> None:
    service.save(ACTOR, name="Zebra", description="d", body="b")
    service.save(ACTOR, name="Apple", description="d", body="b")
    assert [s.name for s in service.list_skills(ACTOR)] == ["Apple", "Zebra"]


def test_get_missing_skill_returns_none(service: SkillService) -> None:
    assert service.get(ACTOR, "nope") is None


def test_delete_removes_skill(service: SkillService) -> None:
    service.save(ACTOR, name="Weekly report", description="d", body="b")
    assert service.delete(ACTOR, "Weekly report") is True
    assert service.get(ACTOR, "Weekly report") is None


def test_delete_missing_skill_returns_false(service: SkillService) -> None:
    assert service.delete(ACTOR, "nope") is False
