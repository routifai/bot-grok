"""``/v1/me/approvals``: the person's say over what the Muse may do without asking.

* ``GET /me/approvals/pending`` lists the prompts still waiting (any session of theirs).
* ``POST /me/approvals/{id}/answer`` answers one: ``once``, ``always`` (also saves a standing
  rule) or ``deny``. An unanswered prompt stays pending; nothing here ever times out to yes.
* ``/me/approval-rules`` lists, adds and revokes standing rules.
* ``/me/approval-settings`` reads and sets the daily spending cap (``0`` = always ask).
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.runner.routing import RunnerRouter
from omnigent.runtime import pending_elicitations
from omnigent.server.auth import LEVEL_EDIT, RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_access_and_level, require_user
from omnigent.server.routes._sessions.helpers import _apply_pending_policy_ask_writes
from omnigent.server.routes._sessions.orchestration import _resolve_elicitation
from omnigent.stores import AgentStore, ConversationStore, PermissionStore
from omnigent.superchat.approvals.policy import (
    CATEGORIES,
    POLICY_NAME,
    decode_reason,
    rule_label,
)
from omnigent.superchat.approvals.store import (
    LOCAL_OWNER,
    ApprovalRule,
    PendingApproval,
    SqlAlchemyApprovalStore,
)

_MAX_CAP_USD = 1_000_000.0


class AnswerBody(BaseModel):
    """Body of ``POST /v1/me/approvals/{id}/answer``."""

    model_config = ConfigDict(extra="forbid")

    decision: Literal["once", "always", "deny"]


class RuleBody(BaseModel):
    """Body of ``POST /v1/me/approval-rules``."""

    model_config = ConfigDict(extra="forbid")

    category: Literal["send", "post", "delete", "spend", "upload", "share"]
    target: str = Field(min_length=1, max_length=256)
    label: str | None = Field(default=None, max_length=256)
    decision: Literal["allow", "deny"] = "allow"


class SettingsBody(BaseModel):
    """Body of ``PUT /v1/me/approval-settings``."""

    model_config = ConfigDict(extra="forbid")

    daily_cap_usd: float = Field(ge=0, le=_MAX_CAP_USD)


def rule_to_response(rule: ApprovalRule) -> dict[str, Any]:
    """Serialize a standing rule."""
    return {
        "id": rule.id,
        "category": rule.category,
        "target": rule.target,
        "label": rule.label or rule_label(rule.category, rule.target),
        "decision": rule.decision,
        "created_at": rule.created_at,
    }


def _today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _decoded(pending: PendingApproval) -> dict[str, Any]:
    try:
        event = json.loads(pending.event)
    except ValueError:
        return {}
    params = event.get("params") if isinstance(event, dict) else None
    if not isinstance(params, dict):
        return {}
    # Filed by the mirror from the server-attested reason; older rows kept the raw reason.
    approval = params.get("approval")
    if isinstance(approval, dict):
        return approval
    return decode_reason(params.get("message")) or {}


def pending_to_response(pending: PendingApproval, cap_usd: float) -> dict[str, Any]:
    """Serialize a pending approval for the card."""
    info = _decoded(pending)
    targets = [t for t in info.get("t", []) if isinstance(t, str)]
    category = pending.category
    return {
        "id": pending.elicitation_id,
        "session_id": pending.session_id,
        "category": category,
        "targets": targets,
        "summary": pending.summary,
        "amount_usd": pending.amount_usd,
        "can_always": bool(targets) and (category != "spend" or cap_usd > 0),
        "always_label": ", ".join(rule_label(category, t) for t in targets),
        "created_at": pending.created_at,
    }


async def answer_approval(
    store: SqlAlchemyApprovalStore,
    *,
    owner: str,
    user_id: str | None,
    elicitation_id: str,
    decision: Literal["once", "always", "deny"],
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    runner_router: RunnerRouter | None,
    permission_store: PermissionStore | None,
) -> None:
    """Answer one waiting approval as *owner*: the single place the decision is applied.

    Used by ``POST /me/approvals/{id}/answer`` and by the decisions inbox
    (``POST /me/asks/{id}/answer``).

    :raises OmnigentError: ``NOT_FOUND`` when the prompt is gone or not the owner's;
        ``INVALID_INPUT`` for ``always`` on a prompt that cannot be allowed every time.
    """
    pending = await asyncio.to_thread(store.get_pending, elicitation_id)
    if pending is None or (pending.user_id or LOCAL_OWNER) != owner:
        raise OmnigentError("Approval not found", code=ErrorCode.NOT_FOUND)
    access = await require_access_and_level(
        user_id, pending.session_id, LEVEL_EDIT, permission_store, conversation_store
    )
    conv = access.conversation or await asyncio.to_thread(
        conversation_store.get_conversation, pending.session_id
    )
    if conv is None:
        raise OmnigentError("Approval not found", code=ErrorCode.NOT_FOUND)
    info = _decoded(pending)
    targets = [t for t in info.get("t", []) if isinstance(t, str)]
    if decision == "always":
        cap = await asyncio.to_thread(store.get_cap, owner)
        if not targets or (pending.category == "spend" and cap <= 0):
            raise OmnigentError("This can't be allowed every time", code=ErrorCode.INVALID_INPUT)
        for target in targets:
            await asyncio.to_thread(
                store.create_rule,
                owner,
                category=pending.category,
                target=target,
                label=rule_label(pending.category, target),
            )
    data = {
        "elicitation_id": elicitation_id,
        "action": "decline" if decision == "deny" else "accept",
    }
    await _resolve_elicitation(pending.session_id, data, runner_router, conversation_store)
    # Count the spend only once the verdict reached the waiting call.
    if decision != "deny" and pending.category == "spend" and pending.amount_usd:
        await asyncio.to_thread(store.add_spend, owner, _today(), pending.amount_usd)
    await _apply_pending_policy_ask_writes(
        pending.session_id, conv, conversation_store, agent_store, data
    )
    await asyncio.to_thread(store.delete_pending, elicitation_id)


def owner_of(user_id: str | None) -> str:
    """The approval-store owner key for an authenticated user (``local`` when auth is off)."""
    return LOCAL_OWNER if user_id in (None, RESERVED_USER_LOCAL) else str(user_id)


def create_approvals_router(
    store: SqlAlchemyApprovalStore,
    *,
    conversation_store: ConversationStore,
    agent_store: AgentStore,
    runner_router: RunnerRouter | None = None,
    permission_store: PermissionStore | None = None,
    auth_provider: AuthProvider | None = None,
) -> APIRouter:
    """Build the approvals router, mounted with ``prefix="/v1"``."""
    router = APIRouter()

    def _owner(request: Request) -> str:
        return owner_of(require_user(request, auth_provider))

    @router.get("/me/approvals/pending")
    async def list_pending(request: Request) -> dict[str, Any]:
        """The caller's approvals still waiting, oldest first."""
        owner = _owner(request)
        rows = await asyncio.to_thread(store.list_pending, user_id=owner)
        cap = await asyncio.to_thread(store.get_cap, owner)
        return {"approvals": [pending_to_response(r, cap) for r in rows]}

    @router.post("/me/approvals/{elicitation_id}/answer")
    async def answer(request: Request, elicitation_id: str, body: AnswerBody) -> dict[str, bool]:
        """Allow once, always allow (saving a rule), or deny a waiting approval."""
        await answer_approval(
            store,
            owner=_owner(request),
            user_id=require_user(request, auth_provider),
            elicitation_id=elicitation_id,
            decision=body.decision,
            conversation_store=conversation_store,
            agent_store=agent_store,
            runner_router=runner_router,
            permission_store=permission_store,
        )
        return {"ok": True}

    @router.get("/me/approval-rules")
    async def list_rules(request: Request) -> dict[str, Any]:
        """The caller's standing rules, newest first."""
        rules = await asyncio.to_thread(store.list_rules, _owner(request))
        return {"rules": [rule_to_response(r) for r in rules]}

    @router.post("/me/approval-rules", status_code=201)
    async def create_rule(request: Request, body: RuleBody) -> dict[str, Any]:
        """Add a standing rule."""
        owner = _owner(request)
        if body.category not in CATEGORIES:
            raise OmnigentError("Unknown category", code=ErrorCode.INVALID_INPUT)
        rule = await asyncio.to_thread(
            store.create_rule,
            owner,
            category=body.category,
            target=body.target.strip(),
            label=body.label or rule_label(body.category, body.target.strip()),
            decision=body.decision,
        )
        return rule_to_response(rule)

    @router.delete("/me/approval-rules/{rule_id}", status_code=204)
    async def delete_rule(request: Request, rule_id: str) -> None:
        """Revoke a standing rule."""
        if not await asyncio.to_thread(store.delete_rule, _owner(request), rule_id):
            raise OmnigentError("Rule not found", code=ErrorCode.NOT_FOUND)

    @router.get("/me/approval-settings")
    async def get_settings(request: Request) -> dict[str, float]:
        """The daily spending cap and what has gone through today."""
        owner = _owner(request)
        return {
            "daily_cap_usd": await asyncio.to_thread(store.get_cap, owner),
            "spent_today_usd": await asyncio.to_thread(store.get_spend, owner, _today()),
        }

    @router.put("/me/approval-settings")
    async def put_settings(request: Request, body: SettingsBody) -> dict[str, float]:
        """Set the daily spending cap (0 = always ask)."""
        owner = _owner(request)
        cap = await asyncio.to_thread(store.set_cap, owner, body.daily_cap_usd)
        return {
            "daily_cap_usd": cap,
            "spent_today_usd": await asyncio.to_thread(store.get_spend, owner, _today()),
        }

    return router


GENERIC_CATEGORY = "tool"
_SUMMARY_PREVIEW_CHARS = 160


def _generic_summary(context: dict[str, Any]) -> str:
    """One line for a policy ask no capability encoded: the reasons, the tool, its arguments."""
    reasons = context.get("policy_reasons") or {}
    reason = "; ".join(str(r).strip() for r in reasons.values() if str(r).strip())
    tool = context.get("tool_name") or "a tool"
    preview = " ".join(str(context.get("content_preview") or "").split())
    if len(preview) > _SUMMARY_PREVIEW_CHARS:
        preview = preview[: _SUMMARY_PREVIEW_CHARS - 1] + "…"
    reason = reason or "Approval required"
    return f"{reason} ({tool}: {preview})" if preview else f"{reason} ({tool})"


def install_pending_persistence(store: SqlAlchemyApprovalStore) -> int:
    """Mirror approval prompts into ``store`` and restore the ones a restart interrupted.

    Only tool-call prompts the server raised itself are filed, from the context it attested
    (:func:`omnigent.runtime.pending_elicitations.attest`): this policy's own reason decoded
    strictly, the owner from the server-set principal. Event text is never trusted. Any other
    policy's ask is filed as a generic one-off ask naming the tool and its arguments.

    :returns: How many pending approvals were put back in the live index.
    """

    def mirror(conversation_id: str, elicitation_id: str, event: dict[str, Any] | None) -> None:
        if event is None:
            store.delete_pending(elicitation_id)
            return
        params = event.get("params")
        if not isinstance(params, dict) or params.get("target_session_id"):
            return  # an ancestor's mirrored copy: the original is filed under its own session
        context = pending_elicitations.attested(elicitation_id)
        if context is None or context.get("phase") != "tool_call":
            return
        run_as = context.get("run_as")
        owner = run_as if isinstance(run_as, str) and run_as else LOCAL_OWNER
        reasons = context.get("policy_reasons") or {}
        info = decode_reason(reasons.get(POLICY_NAME))
        if info is None:
            category, target, summary, amount = (
                GENERIC_CATEGORY,
                str(context.get("tool_name") or ""),
                _generic_summary(context),
                None,
            )
        else:
            targets = [t for t in info.get("t", []) if isinstance(t, str)]
            raw_amount = info.get("a")
            info = {"c": info["c"], "t": targets, "s": str(info.get("s") or "")}
            category, target, summary = info["c"], ", ".join(targets), info["s"]
            amount = float(raw_amount) if isinstance(raw_amount, (int, float)) else None
        stored = {**event, "params": {**params, "approval": info or {}}}
        store.put_pending(
            elicitation_id,
            conversation_id,
            user_id=owner,
            category=category,
            target=target,
            summary=summary,
            amount_usd=amount,
            event=json.dumps(stored),
        )

    restored = 0
    for row in store.list_pending():
        try:
            event = json.loads(row.event)
        except ValueError:
            continue
        if isinstance(event, dict):
            pending_elicitations.restore(row.session_id, event)
            restored += 1
    pending_elicitations.set_persist_hook(mirror)
    return restored
