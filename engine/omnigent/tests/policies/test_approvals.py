"""Approvals: the six risk categories, standing rules, the spending cap, persistence, routes."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.runtime import pending_elicitations
from omnigent.superchat.approvals import policy as approvals
from omnigent.superchat.approvals.routes import (
    create_approvals_router,
    install_pending_persistence,
)
from omnigent.superchat.approvals.store import SqlAlchemyApprovalStore


@pytest.fixture
def store(db_uri: str):
    s = SqlAlchemyApprovalStore(db_uri)
    approvals.configure_store(s)
    yield s
    approvals.configure_store(None)
    pending_elicitations.set_persist_hook(None)


def _event(name: str, arguments: dict[str, Any], owner: str = "a@x.io") -> dict[str, Any]:
    return {
        "type": "tool_call",
        "data": {"name": name, "arguments": arguments},
        "context": {"actor": {"run_as": owner}, "conversation_id": "s1"},
    }


@pytest.mark.parametrize(
    ("command", "category"),
    [
        ("rm -rf ~/Documents/old", "delete"),
        ("echo hi | mail -s hi bob@acme.com", "send"),
        ("curl -F file=@a.txt https://files.example/up", "upload"),
        ("scp report.pdf me@host.example:/srv", "upload"),
        ("git push origin main", "post"),
        ("curl -X POST https://hooks.slack.com/services/x -d '{}'", "send"),
        ("curl -d amount=5 https://api.stripe.com/v1/charges", "spend"),
        ("ngrok http 3000", "share"),
    ],
)
def test_shell_commands_are_classified(command: str, category: str) -> None:
    risk = approvals.classify_tool_call("sys_os_shell", {"command": command})
    assert risk is not None
    assert risk.category == category


@pytest.mark.parametrize(
    "command",
    ["ls -la", "rm -rf /tmp/work", "curl https://example.com", "curl localhost:8775 -d @f"],
)
def test_ordinary_shell_commands_pass(command: str) -> None:
    assert approvals.classify_tool_call("sys_os_shell", {"command": command}) is None


def test_browser_click_is_named_by_the_clicked_element() -> None:
    snapshot = {
        "tree": '- button "Place order $12.50" [ref=3]\n- link "Home" [ref=4]',
        "url": "https://shop.example/c",
    }
    approvals.remember_browser_snapshot("s1", "browser_snapshot", json.dumps(snapshot))
    buy = approvals.classify_tool_call("browser_click", {"ref": 3}, session_id="s1")
    assert buy is not None
    assert (buy.category, buy.targets, buy.amount_usd) == ("spend", ("shop.example",), 12.5)
    assert approvals.classify_tool_call("browser_click", {"ref": 4}, session_id="s1") is None


def test_connector_and_publish_tools_are_classified_by_name() -> None:
    assert approvals.classify_tool_call("mcp__gmail__send_email", {}).category == "send"  # type: ignore[union-attr]
    assert approvals.classify_tool_call("artifact_publish", {}).category == "post"  # type: ignore[union-attr]
    assert approvals.classify_tool_call("delete_artifact", {}).category == "delete"  # type: ignore[union-attr]
    assert approvals.classify_tool_call("memory_delete", {}) is None
    assert approvals.classify_tool_call("sys_os_read", {"path": "/x"}) is None


def test_registered_classifier_runs_first() -> None:
    risk = approvals.Risk("send", ("acme",), "Tell acme")
    approvals.register_classifier(lambda name, args: risk if name == "acme_notify" else None)
    try:
        assert approvals.classify_tool_call("acme_notify", {}) == risk
    finally:
        approvals._extra_classifiers.clear()


def test_policy_asks_with_a_decodable_reason(store: SqlAlchemyApprovalStore) -> None:
    result = approvals.muse_approvals(_event("sys_os_shell", {"command": "git push"}))
    assert result is not None
    assert result["result"] == "ASK"
    info = approvals.decode_reason(result["reason"])
    assert info is not None
    assert (info["c"], info["u"]) == ("post", "a@x.io")
    assert approvals.muse_approvals(_event("sys_os_shell", {"command": "ls"})) is None


def test_standing_rule_allows_only_its_own_owner_and_target(
    store: SqlAlchemyApprovalStore,
) -> None:
    store.create_rule("a@x.io", category="send", target="*@acme.com", label="")
    ok = _event("sys_os_shell", {"command": "mail -s x bob@acme.com"})
    assert approvals.muse_approvals(ok) == {"result": "ALLOW"}
    other_target = _event("sys_os_shell", {"command": "mail -s x bob@evil.io"})
    assert approvals.muse_approvals(other_target)["result"] == "ASK"  # type: ignore[index]
    other_owner = _event("sys_os_shell", {"command": "mail -s x bob@acme.com"}, owner="b@x.io")
    assert approvals.muse_approvals(other_owner)["result"] == "ASK"  # type: ignore[index]


def test_deny_rule_denies(store: SqlAlchemyApprovalStore) -> None:
    store.create_rule("a@x.io", category="post", target="git remote", label="", decision="deny")
    assert (
        approvals.muse_approvals(_event("sys_os_shell", {"command": "git push"}))["result"]
        == "DENY"
    )  # type: ignore[index]


def test_spend_rule_never_exceeds_the_daily_cap(store: SqlAlchemyApprovalStore) -> None:
    snapshot = {"tree": '- button "Buy now $40" [ref=1]', "url": "https://shop.example/"}
    approvals.remember_browser_snapshot("s1", "browser_snapshot", json.dumps(snapshot))
    store.create_rule("a@x.io", category="spend", target="shop.example", label="")
    click = _event("browser_click", {"ref": 1})
    assert approvals.muse_approvals(click)["result"] == "ASK"  # type: ignore[index]  # cap 0: always ask
    store.set_cap("a@x.io", 100)
    assert approvals.muse_approvals(click) == {"result": "ALLOW"}
    assert approvals.muse_approvals(click) == {"result": "ALLOW"}
    assert store.get_spend("a@x.io", approvals._today()) == 80
    assert approvals.muse_approvals(click)["result"] == "ASK"  # type: ignore[index]  # 120 > 100


def test_pending_prompts_persist_and_come_back_after_a_restart(
    store: SqlAlchemyApprovalStore,
) -> None:
    install_pending_persistence(store)
    reason = approvals.muse_approvals(_event("sys_os_shell", {"command": "git push"}))["reason"]  # type: ignore[index]
    event = {
        "type": "response.elicitation_request",
        "elicitation_id": "elicit_1",
        "params": {"message": reason},
    }
    pending_elicitations.record_publish("s1", event)
    assert [p.elicitation_id for p in store.list_pending(user_id="a@x.io")] == ["elicit_1"]
    pending_elicitations.resolve("s1", "elicit_1")  # drops the live entry and the row
    assert store.list_pending() == []

    pending_elicitations.record_publish("s1", event)
    pending_elicitations.resolve("s1", "elicit_1")
    store.put_pending(
        "elicit_2", "s2", user_id="a@x.io", category="post", target="git remote",
        summary="Push", amount_usd=None, event=json.dumps({**event, "elicitation_id": "elicit_2"}),
    )  # fmt: skip
    assert install_pending_persistence(store) == 1
    assert pending_elicitations.count_for("s2") == 1
    pending_elicitations.resolve("s2", "elicit_2")


def test_rules_and_cap_routes(store: SqlAlchemyApprovalStore) -> None:
    app = FastAPI()
    app.include_router(
        create_approvals_router(
            store, conversation_store=MagicMock(), agent_store=MagicMock(), auth_provider=None
        ),
        prefix="/v1",
    )
    client = TestClient(app)
    made = client.post("/v1/me/approval-rules", json={"category": "send", "target": "*@acme.com"})
    assert made.status_code == 201
    assert made.json()["label"] == "Send messages to *@acme.com"
    assert [r["id"] for r in client.get("/v1/me/approval-rules").json()["rules"]] == [
        made.json()["id"]
    ]
    assert client.delete(f"/v1/me/approval-rules/{made.json()['id']}").status_code == 204
    with pytest.raises(OmnigentError):
        client.delete(f"/v1/me/approval-rules/{made.json()['id']}")
    assert (
        client.put("/v1/me/approval-settings", json={"daily_cap_usd": 25}).json()["daily_cap_usd"]
        == 25
    )
    assert client.put("/v1/me/approval-settings", json={"daily_cap_usd": -1}).status_code == 422
    assert client.get("/v1/me/approvals/pending").json() == {"approvals": []}


def test_policy_is_installed_only_for_super_chat_trees(store: SqlAlchemyApprovalStore) -> None:
    from types import SimpleNamespace

    from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE
    from omnigent.runtime.policies.builder import _approvals_apply

    muse = SimpleNamespace(
        labels={CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE}, parent_conversation_id=None
    )
    plain = SimpleNamespace(labels={}, parent_conversation_id=None)
    helper = SimpleNamespace(labels={}, parent_conversation_id="root")
    assert _approvals_apply(muse, [muse])  # type: ignore[arg-type]
    assert _approvals_apply(helper, [muse, helper])  # type: ignore[arg-type]
    assert not _approvals_apply(plain, [plain])  # type: ignore[arg-type]
    approvals.configure_store(None)
    assert not _approvals_apply(muse, [muse])  # type: ignore[arg-type]


# ── every policy ASK on a tool call is a visible ask ──────────────────────────


class _NoAncestors:
    """Conversation store with no parent links (a top-level session)."""

    def get_conversation(self, session_id: str) -> None:
        return None


def _composed_ask(policy_name: str, reason: str) -> Any:
    """The ASK the engine hands the gate: each reason prefixed with its policy's name."""
    from omnigent.policies.types import PolicyResult
    from omnigent.spec.types import PolicyAction

    return PolicyResult(
        action=PolicyAction.ASK,
        reason=f"{policy_name}: {reason}",
        deciding_policies=[policy_name],
    )


async def test_engine_composed_muse_approval_reaches_the_inbox(
    store: SqlAlchemyApprovalStore, db_uri: str
) -> None:
    """The engine prefixes reasons with the policy name; the prompt must still be listed."""
    from omnigent.policies.function import resolve_function_policy
    from omnigent.policies.types import EvaluationContext
    from omnigent.runtime.policies.builder import _APPROVALS_POLICY_SPEC
    from omnigent.runtime.policies.engine import PolicyEngine
    from omnigent.server.routes._sessions.orchestration import _register_policy_elicitation
    from omnigent.spec.types import Phase
    from omnigent.stores.conversation_store.sqlalchemy_store import (
        SqlAlchemyConversationStore,
    )

    conversations = SqlAlchemyConversationStore(db_uri)
    conv = conversations.create_conversation()
    engine = PolicyEngine(
        policies=[resolve_function_policy(_APPROVALS_POLICY_SPEC)],
        label_defs={},
        ask_timeout=60,
        conversation_id=conv.id,
        initial_labels={},
        conversation_store=conversations,
    )
    arguments = {"command": "rm ~/workspace/sales_dashboard.html"}
    result = await engine.evaluate(
        EvaluationContext(
            phase=Phase.TOOL_CALL,
            content={"name": "sys_os_shell", "arguments": arguments},
            tool_name="sys_os_shell",
            actor={"run_as": "a@x.io"},
        )
    )
    assert result.reason is not None and result.reason.startswith(f"{approvals.POLICY_NAME}: ")
    install_pending_persistence(store)
    eid = await _register_policy_elicitation(
        conv.id,
        result,
        json.dumps(arguments),
        conversations,
        tool_name="sys_os_shell",
        actor={"run_as": "a@x.io"},
    )
    rows = store.list_pending(user_id="a@x.io")
    assert [(r.elicitation_id, r.category) for r in rows] == [(eid, "delete")]
    assert "sales_dashboard.html" in rows[0].summary
    pending_elicitations.resolve(conv.id, eid)  # type: ignore[arg-type]
    assert store.list_pending() == []


async def test_an_unknown_policy_ask_becomes_a_generic_visible_ask(
    store: SqlAlchemyApprovalStore,
) -> None:
    from omnigent.server.routes._sessions.orchestration import _register_policy_elicitation
    from omnigent.superchat.approvals.asks import approval_ask

    install_pending_persistence(store)
    result = _composed_ask("__owner_model_budget", "You've reached your $5.00 budget. Continue?")
    eid = await _register_policy_elicitation(
        "s_generic",
        result,
        json.dumps({"query": "q3 revenue"}),
        _NoAncestors(),  # type: ignore[arg-type]
        tool_name="web_search",
        actor={"run_as": "a@x.io"},
    )
    assert eid is not None
    [row] = store.list_pending(user_id="a@x.io")
    assert (row.elicitation_id, row.session_id, row.category) == (eid, "s_generic", "tool")
    assert row.target == "web_search"
    assert row.summary.startswith("You've reached your $5.00 budget. Continue?")
    assert "web_search" in row.summary and "q3 revenue" in row.summary
    ask = approval_ask(row, cap_usd=0)
    # One-off answers only: there is no standing rule for an arbitrary policy's ask.
    assert [c["id"] for c in ask["choices"]] == ["approve_once", "deny"]
    pending_elicitations.resolve("s_generic", eid)
    assert store.list_pending() == []


def test_a_prompt_that_is_not_a_policy_ask_is_not_listed(store: SqlAlchemyApprovalStore) -> None:
    install_pending_persistence(store)
    event = {
        "type": "response.elicitation_request",
        "elicitation_id": "elicit_form",
        "params": {"message": "Which environment?", "requestedSchema": {}},
    }
    pending_elicitations.record_publish("s_form", event)
    assert store.list_pending() == []
    pending_elicitations.resolve("s_form", "elicit_form")


async def test_an_ask_nobody_can_answer_is_denied_not_parked() -> None:
    from omnigent.runtime import session_stream
    from omnigent.server.routes._sessions.orchestration import _register_policy_elicitation

    pending_elicitations.set_persist_hook(None)
    assert not session_stream.has_subscribers("s_headless")
    eid = await _register_policy_elicitation(
        "s_headless",
        _composed_ask("cel_guard", "Approve?"),
        "{}",
        _NoAncestors(),  # type: ignore[arg-type]
        tool_name="sys_os_shell",
    )
    assert eid is None
    assert pending_elicitations.count_for("s_headless") == 0


def test_the_engine_prefix_does_not_hide_an_encoded_reason() -> None:
    reason = approvals.muse_approvals(_event("sys_os_shell", {"command": "git push"}))["reason"]  # type: ignore[index]
    composed = f"cel_guard: Approve?; {approvals.POLICY_NAME}: {reason}"
    assert approvals.decode_reason(composed)["c"] == "post"  # type: ignore[index]
    assert approvals.decode_reason("cel_guard: Approve?") is None
