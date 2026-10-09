"""Monthly model budget as a policy: pure evaluation, auto-injection and approval routing."""

from __future__ import annotations

from pathlib import Path

import pytest

from omnigent.db.utils import now_epoch
from omnigent.model_credentials import budget as budget_module
from omnigent.model_credentials.budget import (
    WORKSPACE_OWNER,
    Budget,
    ModelBudgets,
    ModelBudgetStore,
    approval_bucket,
    bind_budgets,
    month_start,
)
from omnigent.policies.builtins.model_budget import ask_level, owner_model_budget
from omnigent.policies.function import FunctionPolicy
from omnigent.policies.schema import OWNER_BUDGET_ASK_APPROVED_STATE_KEY
from omnigent.policies.types import EvaluationContext
from omnigent.runtime.policies.builder import any_policies_apply, build_policy_engine
from omnigent.runtime.policies.engine import PolicyEngine
from omnigent.spec.parser import parse
from omnigent.spec.types import (
    FunctionPolicySpec,
    FunctionRef,
    Phase,
    PolicyAction,
)
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.stores.permission_store.sqlalchemy_store import SqlAlchemyPermissionStore


def _event(seed: dict | None, phase: str = "request") -> dict:
    return {"type": phase, "context": {"user_daily_cost": seed or {}}}


def _seed(**fields) -> dict:
    return {"month_period": "2026-10-01", **fields}


# ── pure evaluation ────────────────────────────────────


def test_abstains_without_a_seed_or_below_the_limit() -> None:
    evaluate = owner_model_budget()
    assert evaluate(_event(None))["result"] == "ALLOW"
    below = _seed(month_limit_usd=10.0, month_at_limit="stop", month_cost_usd=9.99)
    assert evaluate(_event(below))["result"] == "ALLOW"
    assert evaluate(_event(below, phase="response"))["result"] == "ALLOW"


@pytest.mark.parametrize("phase", ["request", "tool_call"])
def test_stop_denies_at_the_limit_with_a_clear_message(phase: str) -> None:
    seed = _seed(month_limit_usd=10.0, month_at_limit="stop", month_cost_usd=10.0)
    out = owner_model_budget()(_event(seed, phase))
    assert out["result"] == "DENY"
    assert out["reason"] == (
        "You've reached your $10.00 monthly budget. Raise or remove the limit in Settings "
        "to continue."
    )


def test_ask_asks_once_then_again_every_quarter_of_the_limit() -> None:
    evaluate = owner_model_budget()
    seed = _seed(
        month_limit_usd=20.0, month_at_limit="ask", month_cost_usd=20.5, month_ask_level=0.0
    )
    out = evaluate(_event(seed))
    assert out["result"] == "ASK"
    assert out["reason"] == "You've reached your $20.00 monthly budget. Continue?"
    assert out["state_updates"] == [
        {"key": OWNER_BUDGET_ASK_APPROVED_STATE_KEY, "action": "set", "value": 1.0}
    ]
    approved = {**seed, "month_ask_level": 1.0}
    assert evaluate(_event(approved))["result"] == "ALLOW"
    # +25% of the limit later the next check-in comes.
    later = {**approved, "month_cost_usd": 25.0}
    assert evaluate(_event(later))["state_updates"][0]["value"] == 1.25


def test_org_cap_applies_and_a_stop_beats_an_ask() -> None:
    evaluate = owner_model_budget()
    org_only = _seed(org_limit_usd=100.0, org_at_limit="stop", org_cost_usd=100.0)
    out = evaluate(_event(org_only))
    assert out["result"] == "DENY" and "organization" in out["reason"]
    both = _seed(
        month_limit_usd=5.0,
        month_at_limit="ask",
        month_cost_usd=6.0,
        org_limit_usd=100.0,
        org_at_limit="stop",
        org_cost_usd=101.0,
    )
    assert evaluate(_event(both))["result"] == "DENY"


def test_ask_level_steps() -> None:
    assert ask_level(9.99, 10.0) is None
    assert ask_level(10.0, 10.0) == 1.0
    assert ask_level(12.4, 10.0) == 1.0
    assert ask_level(12.5, 10.0) == 1.25
    assert ask_level(20.0, 10.0) == 2.0


# ── seed from the ledger ───────────────────────────────


@pytest.fixture
def budgets(db_uri: str, conversation_store: SqlAlchemyConversationStore) -> ModelBudgets:
    return ModelBudgets(ModelBudgetStore(db_uri), conversation_store)


def test_seed_only_exists_when_a_limit_does(budgets, conversation_store) -> None:
    assert budgets.seed_for_policy("alice", conversation_store) is None
    budgets.store.set("alice", Budget(10.0, "stop"))
    seed = budgets.seed_for_policy("alice", conversation_store)
    assert seed["month_limit_usd"] == 10.0 and seed["month_at_limit"] == "stop"
    assert "org_limit_usd" not in seed
    # Someone else without a limit of their own is not seeded (no org cap yet).
    assert budgets.seed_for_policy("bob", conversation_store) is None


def test_month_to_date_sums_this_month_only_and_org_sums_all_users(
    budgets, conversation_store, monkeypatch
) -> None:
    monkeypatch.setattr(budget_module, "now_epoch", lambda: 1_792_000_000)  # 2026-10-14
    day = budget_module.utc_day(1_792_000_000)
    assert month_start() == day[:7] + "-01"
    conversation_store.add_daily_cost("alice", "2026-09-30", 50.0)  # last month
    conversation_store.add_daily_cost("alice", "2026-10-01", 2.0)
    conversation_store.add_daily_cost("alice", day, 3.0)
    conversation_store.add_daily_cost("bob", day, 7.0)
    assert budgets.spent("alice") == pytest.approx(5.0)
    assert budgets.org_spent() == pytest.approx(12.0)
    budgets.store.set(WORKSPACE_OWNER, Budget(10.0, "stop"))
    seed = budgets.seed_for_policy("alice", conversation_store)
    assert seed["org_cost_usd"] == pytest.approx(12.0) and "month_limit_usd" not in seed
    # Org cap applies to a user who has no limit of their own.
    assert [b.scope for b in budgets.breaches("alice")] == ["org"]
    # The new month starts clean: nothing from 2026-10 counts in 2026-11.
    monkeypatch.setattr(budget_module, "now_epoch", lambda: 1_794_700_000)  # 2026-11-14
    assert budgets.spent("alice") == 0.0 and budgets.org_spent() == 0.0
    assert budgets.breaches("alice") == []


def test_approval_bucket_does_not_count_as_spend_and_resets_monthly(
    budgets, conversation_store, monkeypatch
) -> None:
    monkeypatch.setattr(budget_module, "now_epoch", lambda: 1_792_000_000)
    conversation_store.add_daily_cost("alice", "2026-10-14", 1.0)
    conversation_store.set_daily_ask_approved("alice", approval_bucket(), 1.25)
    assert budgets.spent("alice") == pytest.approx(1.0)
    assert budgets.org_spent() == pytest.approx(1.0)
    budgets.store.set("alice", Budget(0.5, "ask"))
    assert budgets.seed_for_policy("alice", conversation_store)["month_ask_level"] == 1.25
    monkeypatch.setattr(budget_module, "now_epoch", lambda: 1_794_700_000)
    assert budgets.seed_for_policy("alice", conversation_store)["month_ask_level"] == 0.0


# ── engine routing and auto-injection ──────────────────


def _owned_conversation(conversation_store, db_uri: str, owner: str) -> str:
    conv = conversation_store.create_conversation()
    perms = SqlAlchemyPermissionStore(db_uri)
    perms.ensure_user(owner)
    perms.grant(owner, conv.id, 4)
    return conv.id


@pytest.mark.asyncio
async def test_approval_is_stored_for_the_month_and_not_asked_again(
    conversation_store, db_uri: str
) -> None:
    conv_id = _owned_conversation(conversation_store, db_uri, "alice")
    policy = FunctionPolicy(
        FunctionPolicySpec(
            name="b",
            on=None,
            function=FunctionRef(
                path="omnigent.policies.builtins.model_budget.owner_model_budget"
            ),
        ),
        owner_model_budget(),
    )
    engine = PolicyEngine(
        policies=[policy],
        label_defs={},
        ask_timeout=30,
        conversation_id=conv_id,
        initial_labels={},
        initial_user_daily_cost=_seed(
            month_limit_usd=10.0, month_at_limit="ask", month_cost_usd=11.0, month_ask_level=0.0
        ),
        conversation_store=conversation_store,
    )
    ctx = EvaluationContext(phase=Phase.REQUEST, content={})
    first = await engine.evaluate(ctx)
    assert first.action == PolicyAction.ASK
    engine.apply_state_updates(first.state_updates)
    assert conversation_store.get_daily_cost_state("alice", approval_bucket())[
        "ask_approved_usd"
    ] == pytest.approx(1.0)
    # Not in session_state, and the same engine does not ask again.
    assert OWNER_BUDGET_ASK_APPROVED_STATE_KEY not in engine.session_state
    assert (await engine.evaluate(ctx)).action == PolicyAction.ALLOW


def _spec(tmp_path: Path):
    (tmp_path / "config.yaml").write_text("spec_version: 1\nname: plain\n")
    return parse(tmp_path)


def test_policy_is_injected_only_for_owners_with_a_limit(
    tmp_path, conversation_store, db_uri, budgets
) -> None:
    bind_budgets(budgets)
    try:
        spec = _spec(tmp_path)
        alice = _owned_conversation(conversation_store, db_uri, "alice")
        bob = _owned_conversation(conversation_store, db_uri, "bob")

        def names(conv_id: str) -> list[str]:
            engine = build_policy_engine(
                spec=spec, conversation_id=conv_id, conversation_store=conversation_store
            )
            return [p.spec.name for p in engine.policies]

        assert "__owner_model_budget" not in names(alice)
        assert not any_policies_apply(
            spec=spec, conversation_id=alice, default_policies=None, policy_store=None
        )
        budgets.store.set("alice", Budget(10.0, "stop"))
        assert "__owner_model_budget" in names(alice)
        assert "__owner_model_budget" not in names(bob)
        assert any_policies_apply(
            spec=spec, conversation_id=bob, default_policies=None, policy_store=None
        )
        # An organization cap reaches everyone.
        budgets.store.set("alice", Budget())
        budgets.store.set(WORKSPACE_OWNER, Budget(100.0, "ask"))
        assert "__owner_model_budget" in names(bob)
        budgets.store.set(WORKSPACE_OWNER, Budget())
        assert "__owner_model_budget" not in names(bob)
    finally:
        bind_budgets(None)


@pytest.mark.asyncio
async def test_built_engine_denies_at_month_to_date_limit(
    tmp_path, conversation_store, db_uri, budgets
) -> None:
    bind_budgets(budgets)
    try:
        spec = _spec(tmp_path)
        conv_id = _owned_conversation(conversation_store, db_uri, "alice")
        budgets.store.set("alice", Budget(10.0, "stop"))
        conversation_store.add_daily_cost("alice", budget_module.utc_day(now_epoch()), 9.0)

        def build():
            return build_policy_engine(
                spec=spec, conversation_id=conv_id, conversation_store=conversation_store
            )

        ctx = EvaluationContext(phase=Phase.REQUEST, content={})
        assert (await build().evaluate(ctx)).action == PolicyAction.ALLOW
        conversation_store.add_daily_cost("alice", budget_module.utc_day(now_epoch()), 1.0)
        result = await build().evaluate(ctx)
        assert result.action == PolicyAction.DENY
        assert "monthly budget" in (result.reason or "")
    finally:
        bind_budgets(None)
