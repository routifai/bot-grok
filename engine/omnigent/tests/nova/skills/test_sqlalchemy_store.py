"""Tests for :class:`SqlAlchemySkillStore` against a real SQLite database."""

from __future__ import annotations

import pytest

from omnigent.nova._shared import NovaActor, new_id
from omnigent.nova.skills.entities import OfferKind, OfferStatus
from omnigent.nova.skills.sqlalchemy_store import SqlAlchemySkillStore

OWNER = NovaActor(user_id="alice@example.com", workspace_id=0)
OTHER = NovaActor(user_id="bob@example.com", workspace_id=0)


@pytest.fixture()
def store(db_uri: str) -> SqlAlchemySkillStore:
    return SqlAlchemySkillStore(db_uri)


# ── skills ───────────────────────────────────────────────────────────────────


def test_create_skill_round_trips(store: SqlAlchemySkillStore) -> None:
    skill = store.create_skill(
        new_id(), OWNER, name="Weekly report", description="d", content="---\ncontent\n---\n"
    )
    assert skill.name == "Weekly report"
    assert skill.user_id == OWNER.user_id
    assert skill.created_at > 0
    assert skill.updated_at == skill.created_at


def test_get_skill_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_skill(new_id(), OWNER, name="Mine", description="d", content="c")
    assert store.get_skill(OWNER, "Mine") is not None
    assert store.get_skill(OTHER, "Mine") is None


def test_list_skills_alphabetical(store: SqlAlchemySkillStore) -> None:
    store.create_skill(new_id(), OWNER, name="Zebra", description="d", content="c")
    store.create_skill(new_id(), OWNER, name="Apple", description="d", content="c")
    assert [s.name for s in store.list_skills(OWNER)] == ["Apple", "Zebra"]


def test_list_skills_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_skill(new_id(), OWNER, name="Mine", description="d", content="c")
    store.create_skill(new_id(), OTHER, name="Theirs", description="d", content="c")
    assert [s.name for s in store.list_skills(OWNER)] == ["Mine"]


def test_delete_skill_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_skill(new_id(), OWNER, name="Mine", description="d", content="c")
    assert store.delete_skill(OTHER, "Mine") is False
    assert store.delete_skill(OWNER, "Mine") is True
    assert store.get_skill(OWNER, "Mine") is None


def test_delete_skill_idempotent(store: SqlAlchemySkillStore) -> None:
    assert store.delete_skill(OWNER, "nope") is False


def test_update_skill_replaces_description_and_content_keeps_name_and_id(
    store: SqlAlchemySkillStore,
) -> None:
    original = store.create_skill(
        new_id(), OWNER, name="Weekly report", description="d", content="c"
    )
    updated = store.update_skill(OWNER, "Weekly report", description="d2", content="c2")
    assert updated is not None
    assert updated.id == original.id
    assert updated.name == "Weekly report"
    assert updated.description == "d2"
    assert updated.content == "c2"
    assert updated.updated_at >= original.updated_at


def test_update_skill_missing_returns_none(store: SqlAlchemySkillStore) -> None:
    assert store.update_skill(OWNER, "nope", description="d", content="c") is None


def test_update_skill_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_skill(new_id(), OWNER, name="Mine", description="d", content="c")
    assert store.update_skill(OTHER, "Mine", description="d2", content="c2") is None


# ── offers ───────────────────────────────────────────────────────────────────


def test_create_offer_round_trips(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="Weekly report", description="d", content="c")
    assert offer.status is OfferStatus.OPEN
    assert offer.decided_at is None
    assert offer.offer_kind is OfferKind.NEW
    assert offer.target_skill is None


def test_create_offer_as_update_round_trips(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(
        new_id(),
        OWNER,
        name="Weekly report",
        description="d",
        content="c",
        offer_kind=OfferKind.UPDATE,
        target_skill="Weekly report",
    )
    assert offer.offer_kind is OfferKind.UPDATE
    assert offer.target_skill == "Weekly report"


def test_list_open_offers_newest_first(
    store: SqlAlchemySkillStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    ticks = iter([1_000, 1_001])
    monkeypatch.setattr("omnigent.nova.skills.sqlalchemy_store.now_epoch", lambda: next(ticks))
    first = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    second = store.create_offer(new_id(), OWNER, name="B", description="d", content="c")
    offers = store.list_open_offers(OWNER)
    assert [o.id for o in offers] == [second.id, first.id]


def test_list_open_offers_excludes_decided(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    store.decide_offer(OWNER, offer.id, status=OfferStatus.SAVED)
    assert store.list_open_offers(OWNER) == []


def test_list_open_offers_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_offer(new_id(), OWNER, name="Mine", description="d", content="c")
    store.create_offer(new_id(), OTHER, name="Theirs", description="d", content="c")
    assert [o.name for o in store.list_open_offers(OWNER)] == ["Mine"]


def test_get_offer_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    assert store.get_offer(OTHER, offer.id) is None
    assert store.get_offer(OWNER, offer.id) is not None


def test_find_blocking_offer_matches_open_and_dismissed(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    assert store.find_blocking_offer(OWNER, "A") is not None

    store.decide_offer(OWNER, offer.id, status=OfferStatus.DISMISSED)
    assert store.find_blocking_offer(OWNER, "A") is not None


def test_find_blocking_offer_ignores_saved(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    store.decide_offer(OWNER, offer.id, status=OfferStatus.SAVED)
    assert store.find_blocking_offer(OWNER, "A") is None


def test_find_blocking_offer_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    store.create_offer(new_id(), OTHER, name="A", description="d", content="c")
    assert store.find_blocking_offer(OWNER, "A") is None


def test_decide_offer_rejects_already_decided(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    assert store.decide_offer(OWNER, offer.id, status=OfferStatus.SAVED) is not None
    assert store.decide_offer(OWNER, offer.id, status=OfferStatus.DISMISSED) is None


def test_decide_offer_scoped_to_owner(store: SqlAlchemySkillStore) -> None:
    offer = store.create_offer(new_id(), OWNER, name="A", description="d", content="c")
    assert store.decide_offer(OTHER, offer.id, status=OfferStatus.SAVED) is None
