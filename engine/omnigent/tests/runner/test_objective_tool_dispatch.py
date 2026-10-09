"""Tests for the ``objective_*`` tools: registration gate and runner dispatch."""

from __future__ import annotations

import json
from typing import Any

import pytest

from omnigent.context.labels import CONTEXT_MODE_LABEL, SUBAGENT_LABEL_KEY
from omnigent.runner.tool_dispatch import (
    _ALL_LOCAL_TOOLS,
    _NATIVE_RELAY_BUILTIN_TOOLS,
)
from omnigent.spec.types import AgentSpec
from omnigent.superchat.feature import HandlerCtx
from omnigent.superchat.goals.handlers import handle_objective_tool
from omnigent.tools.manager import ToolManager


async def _execute_objective_tool(
    tool_name: str, arguments: str, *, server_client: Any, conversation_id: str
) -> str:
    """Run the objective handler the way the runner dispatch does (args pre-parsed)."""
    return await handle_objective_tool(
        HandlerCtx(tool_name, server_client, conversation_id), json.loads(arguments)
    )


_OID = "0123456789abcdef0123456789abcdef"
_TID = "fedcba9876543210fedcba9876543210"
_PARENT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
_HELPER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"


class _Resp:
    def __init__(self, status_code: int = 200, body: object | None = None) -> None:
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = json.dumps(self._body)

    def json(self) -> object:
        return self._body


class _Client:
    """Serves session lookups and records objective calls."""

    def __init__(
        self, sessions: dict[str, dict[str, Any]], objective_parent: str = _PARENT
    ) -> None:
        self.sessions = sessions
        self.objective_parent = objective_parent
        self.calls: list[tuple[str, str, Any]] = []

    async def get(self, url: str, *, timeout: object = None) -> _Resp:
        if url.startswith("/v1/sessions/"):
            return _Resp(body=self.sessions[url.rsplit("/", 1)[1]])
        self.calls.append(("GET", url, None))
        return _Resp(body={"id": _OID, "parent_session_id": self.objective_parent})

    async def post(self, url: str, *, json: Any = None, timeout: object = None) -> _Resp:
        self.calls.append(("POST", url, json))
        return _Resp(body={"ok": True})

    async def patch(self, url: str, *, json: Any = None, timeout: object = None) -> _Resp:
        self.calls.append(("PATCH", url, json))
        return _Resp(body={"ok": True})


def _client(**kw: Any) -> _Client:
    return _Client(
        {
            _PARENT: {"kind": "default", "parent_session_id": None},
            _HELPER: {"kind": "sub_agent", "parent_session_id": _PARENT},
        },
        **kw,
    )


def _names(labels: dict[str, str]) -> set[str]:
    mgr = ToolManager(AgentSpec(spec_version=1), labels=labels)
    return {
        s["function"]["name"]
        for s in mgr.get_tool_schemas()
        if s["function"]["name"].startswith("objective_")
    }


def test_registration_gate() -> None:
    mode = {CONTEXT_MODE_LABEL: "superside-chat"}
    assert _names(mode) == {
        "objective_create",
        "objective_get",
        "objective_list",
        "objective_update_task",
        "objective_propose",
    }
    assert _names({**mode, SUBAGENT_LABEL_KEY: "goal"}) == {
        "objective_get",
        "objective_update_task",
        "objective_propose",
    }
    assert _names({}) == set()
    assert (
        "objective_create" in _ALL_LOCAL_TOOLS and "objective_get" in _NATIVE_RELAY_BUILTIN_TOOLS
    )


@pytest.mark.asyncio
async def test_create_posts_objective_for_calling_session() -> None:
    c = _client()
    args = {"title": "T", "plan": ["a", {"title": "b"}], "cadence": "FREQ=DAILY"}
    out = await _execute_objective_tool(
        "objective_create", json.dumps(args), server_client=c, conversation_id=_PARENT
    )
    assert json.loads(out) == {"ok": True}
    method, url, body = c.calls[-1]
    assert (method, url) == ("POST", "/v1/objectives")
    assert body["parent_session_id"] == _PARENT and body["rrule"] == "FREQ=DAILY"
    assert body["plan"] == [{"title": "a"}, {"title": "b"}]


@pytest.mark.asyncio
async def test_helper_refused_create_and_list() -> None:
    c = _client()
    for tool in ("objective_create", "objective_list"):
        out = await _execute_objective_tool(tool, "{}", server_client=c, conversation_id=_HELPER)
        assert "not available to sub-agent" in json.loads(out)["error"]
    assert c.calls == []


@pytest.mark.asyncio
async def test_helper_updates_only_its_parents_objective() -> None:
    args = json.dumps({"objective_id": _OID, "task_id": _TID, "status": "done", "note": "x"})
    ok = _client()
    out = await _execute_objective_tool(
        "objective_update_task", args, server_client=ok, conversation_id=_HELPER
    )
    assert json.loads(out) == {"ok": True}
    assert ok.calls[-1] == (
        "PATCH",
        f"/v1/objectives/{_OID}/tasks/{_TID}",
        {"status": "done", "note": "x"},
    )
    other = _client(objective_parent="cccccccccccccccccccccccccccccccc")
    out = await _execute_objective_tool(
        "objective_update_task", args, server_client=other, conversation_id=_HELPER
    )
    assert "not this helper's objective" in json.loads(out)["error"]
    assert all(m != "PATCH" for m, _, _ in other.calls)


@pytest.mark.asyncio
async def test_propose_normalizes_plan_and_validates_ids() -> None:
    c = _client()
    args = {"objective_id": _OID, "reason": "r", "plan": [{"id": _TID, "title": "a"}, "b"]}
    await _execute_objective_tool(
        "objective_propose", json.dumps(args), server_client=c, conversation_id=_PARENT
    )
    assert c.calls[-1][2] == {"reason": "r", "plan": [{"title": "a", "id": _TID}, {"title": "b"}]}
    bad = await _execute_objective_tool(
        "objective_get",
        json.dumps({"objective_id": "zz"}),
        server_client=c,
        conversation_id=_PARENT,
    )
    assert "objective_id" in json.loads(bad)["error"]


class _ListClient(_Client):
    def __init__(self, objectives: list[dict[str, Any]]) -> None:
        super().__init__({_PARENT: {"kind": "default", "parent_session_id": None}})
        self.objectives = objectives

    async def get(self, url: str, *, timeout: object = None) -> _Resp:
        if url.startswith("/v1/objectives?"):
            self.calls.append(("GET", url, None))
            return _Resp(body={"objectives": self.objectives})
        return await super().get(url, timeout=timeout)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("existing", "new", "dup"),
    [
        (
            "Ship approvals framework for bank assistant",
            "Ship one-page approvals framework for bank assistant",
            True,
        ),
        ("Approvals framework", "Ship the approvals framework now", True),
        ("Ship approvals framework", "Prepare the March audit", False),
    ],
)
async def test_create_returns_existing_similar_objective(
    existing: str, new: str, dup: bool
) -> None:
    c = _ListClient([{"id": _OID, "title": existing, "status": "active", "open_proposal": None}])
    out = json.loads(
        await _execute_objective_tool(
            "objective_create",
            json.dumps({"title": new, "plan": ["a"]}),
            server_client=c,
            conversation_id=_PARENT,
        )
    )
    posted = [x for x in c.calls if x[0] == "POST"]
    if dup:
        assert out["id"] == _OID and "already exists" in out["note"] and not posted
    else:
        assert posted


@pytest.mark.asyncio
async def test_create_ignores_archived_duplicate_and_never_touches_proposals() -> None:
    c = _ListClient([{"id": _OID, "title": "Same goal", "status": "archived"}])
    await _execute_objective_tool(
        "objective_create",
        json.dumps({"title": "Same goal", "plan": ["a"]}),
        server_client=c,
        conversation_id=_PARENT,
    )
    assert [x[1] for x in c.calls if x[0] != "GET"] == ["/v1/objectives"]
