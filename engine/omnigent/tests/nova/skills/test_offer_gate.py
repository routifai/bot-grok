"""Integration tests for the offer gates, exercised through ``SkillService``.

``test_gate.py`` covers each heuristic in ``gate.py`` in isolation; this file
exercises them the way ``nova_offer_skill`` actually calls them — through
``SkillService.offer``/``accept_offer`` against a real ``SqlAlchemySkillStore``
— one scenario per rule, plus the update-offer path (rule 4) and accepting it.
"""

from __future__ import annotations

import pytest

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaActor
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.store import EpisodeStore
from omnigent.nova.skills.entities import OfferKind
from omnigent.nova.skills.service import SkillService
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

ACTOR = NovaActor(user_id="alice@example.com", workspace_id=0)

VALID_BODY = (
    "When to use: whenever this task comes up again.\n\n"
    "## Steps\n"
    "1. Do the first thing.\n"
    "2. Do the second thing.\n"
    "3. Do the third thing.\n"
)
NAME = "Weekly investor update"
DESCRIPTION = "Summarize the week's metrics for investors."


class _FakeEpisodeStore(EpisodeStore):
    """In-memory ``EpisodeStore`` returning a fixed list."""

    def __init__(self, episodes: list[Episode] | None = None) -> None:
        super().__init__("memory://")
        self._episodes = episodes or []

    def upsert(self, **kwargs: object) -> Episode:  # pragma: no cover - unused here
        raise NotImplementedError

    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        del actor
        return self._episodes[:limit]

    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:  # pragma: no cover
        raise NotImplementedError


def _episode(title: str, summary: str) -> Episode:
    return Episode(
        id="e" * 32,
        workspace_id=0,
        user_id=ACTOR.user_id,
        session_id="s",
        turn_id="t",
        title=title,
        summary=summary,
        tools=(),
        links=(),
        created_at=1_700_000_000,
    )


def _matches_store(name: str, description: str) -> _FakeEpisodeStore:
    """Two episodes worded to satisfy rule 3 for exactly this name/description."""
    return _FakeEpisodeStore([_episode(name, description), _episode(name, description)])


NO_EPISODES = _FakeEpisodeStore([])
TWO_MATCHES = _matches_store(NAME, DESCRIPTION)


@pytest.fixture()
def service(db_uri: str) -> SkillService:
    return SkillService(SqlAlchemySkillStore(db_uri))


# ── rule 1: never after a failed turn ───────────────────────────────────────


def test_offer_refuses_out_of_a_failing_turn(service: SkillService) -> None:
    with pytest.raises(OmnigentError, match="failed_turn"):
        service.offer(
            ACTOR,
            name=NAME,
            description=DESCRIPTION,
            body=VALID_BODY,
            turn_failed=True,
            episode_store=TWO_MATCHES,
        )


# ── rule 2: a procedure, not a topic ────────────────────────────────────────


def test_offer_refuses_a_topic_summary_body(service: SkillService) -> None:
    topic_body = "Card A has better travel rewards than Card B, and no annual fee."
    with pytest.raises(OmnigentError, match="not_a_procedure"):
        service.offer(
            ACTOR,
            name=NAME,
            description=DESCRIPTION,
            body=topic_body,
            episode_store=TWO_MATCHES,
        )


# ── rule 3: evidence of reuse ────────────────────────────────────────────────


def test_offer_refuses_with_no_episode_evidence_and_no_reason(service: SkillService) -> None:
    with pytest.raises(OmnigentError, match="no_reuse_evidence"):
        service.offer(
            ACTOR, name=NAME, description=DESCRIPTION, body=VALID_BODY, episode_store=NO_EPISODES
        )


def test_offer_refuses_with_only_one_matching_episode(service: SkillService) -> None:
    one_match = _FakeEpisodeStore([_episode(NAME, DESCRIPTION)])
    with pytest.raises(OmnigentError, match="no_reuse_evidence"):
        service.offer(
            ACTOR, name=NAME, description=DESCRIPTION, body=VALID_BODY, episode_store=one_match
        )


def test_offer_allows_with_two_matching_episodes(service: SkillService) -> None:
    offer = service.offer(
        ACTOR, name=NAME, description=DESCRIPTION, body=VALID_BODY, episode_store=TWO_MATCHES
    )
    assert offer.offer_kind is OfferKind.NEW


def test_offer_refuses_reason_asked_without_an_actual_cue(service: SkillService) -> None:
    # An unverified `reason` argument is not itself evidence (gate.py).
    with pytest.raises(OmnigentError, match="no_reuse_evidence"):
        service.offer(
            ACTOR,
            name=NAME,
            description=DESCRIPTION,
            body=VALID_BODY,
            reason="asked",
            latest_user_message="ok sounds good",
            episode_store=NO_EPISODES,
        )


def test_offer_allows_reason_asked_with_an_actual_cue_and_no_episodes(
    service: SkillService,
) -> None:
    offer = service.offer(
        ACTOR,
        name=NAME,
        description=DESCRIPTION,
        body=VALID_BODY,
        reason="asked",
        latest_user_message="Please remember how to do this next time.",
        episode_store=NO_EPISODES,
    )
    assert offer.offer_kind is OfferKind.NEW


def test_offer_allows_reason_corrected_with_an_actual_cue(service: SkillService) -> None:
    offer = service.offer(
        ACTOR,
        name=NAME,
        description=DESCRIPTION,
        body=VALID_BODY,
        reason="corrected",
        latest_user_message="No, do it like this instead next time.",
        episode_store=NO_EPISODES,
    )
    assert offer.offer_kind is OfferKind.NEW


def test_offer_ignores_reason_repeated_without_episode_evidence(service: SkillService) -> None:
    # "repeated" isn't a cue-bypass reason (only asked/corrected are) — still
    # needs real episode evidence.
    with pytest.raises(OmnigentError, match="no_reuse_evidence"):
        service.offer(
            ACTOR,
            name=NAME,
            description=DESCRIPTION,
            body=VALID_BODY,
            reason="repeated",
            episode_store=NO_EPISODES,
        )


# ── rule 4: improve before creating ──────────────────────────────────────────


def test_offer_creates_an_update_offer_for_a_clearly_similar_saved_skill(
    service: SkillService,
) -> None:
    service.save(ACTOR, name=NAME, description=DESCRIPTION, body="b")
    offer = service.offer(
        ACTOR,
        name="Weekly investor summary",
        description=DESCRIPTION,
        body=VALID_BODY,
        episode_store=TWO_MATCHES,
    )
    assert offer.offer_kind is OfferKind.UPDATE
    assert offer.target_skill == NAME
    assert offer.name == NAME  # keeps the existing skill's name, not the proposed one


def test_accepting_an_update_offer_replaces_the_skills_body_keeping_its_name(
    service: SkillService,
) -> None:
    original = service.save(ACTOR, name=NAME, description=DESCRIPTION, body="the old body")
    offer = service.offer(
        ACTOR,
        name="Weekly investor summary",
        description=DESCRIPTION,
        body=VALID_BODY,
        episode_store=TWO_MATCHES,
    )
    assert offer.offer_kind is OfferKind.UPDATE
    updated = service.accept_offer(ACTOR, offer.id)
    assert updated.name == NAME
    assert updated.id == original.id
    assert "the old body" not in updated.content
    assert "Do the first thing" in updated.content
    assert len(service.list_skills(ACTOR)) == 1
