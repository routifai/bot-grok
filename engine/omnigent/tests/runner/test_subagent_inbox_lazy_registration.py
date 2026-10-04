"""Regression test: a tool dispatch for a conversation this runner is
serving must never hard-fail with "requires parent session inbox" just
because ``_session_inboxes`` has no entry for it yet.

Symptom this reproduces: a sub-agent session created on an earlier
runner process is resumed on a fresh runner process (server + host
daemon restart) via a plain message forward that never goes through
the runner's ``POST /v1/sessions`` handshake (the only place that
pre-populates ``_session_inboxes``). When that resumed session then
calls ``web_fetch`` (or ``sys_session_send``), the dispatch site looks
up ``_session_inboxes.get(conv_id)`` and finds nothing, passes
``session_inbox=None`` into ``_execute_subagent_tool``, which — before
the fix — hard-refuses with "Error: sys_session_send requires parent
session inbox" instead of healing by registering a fresh queue for a
conversation it is actively dispatching for.

See ``omnigent/runner/tool_dispatch.py::_execute_subagent_tool`` and
``omnigent/runner/app.py``'s ``_session_inboxes`` / ``_session_inboxes_ref``.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest


@pytest.mark.asyncio
async def test_web_fetch_lazily_registers_missing_session_inbox(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``web_fetch`` must not fail just because this runner never saw a
    ``POST /v1/sessions`` for the calling conversation.

    Mirrors a resumed sub-agent session on a fresh runner process: the
    conversation has no entry in ``_session_inboxes_ref`` and the dispatch
    site has no ``session_inbox`` to pass in (``session_inbox=None``, as
    ``_session_inboxes.get(conv_id)`` would return on a cold process). The
    call must still succeed, by lazily registering a queue for this
    conversation rather than erroring.
    """
    from omnigent.runner import app as runner_app
    from omnigent.runner.tool_dispatch import execute_tool

    conversation_id = "conv_resumed_child"
    create_bodies: list[dict[str, Any]] = []

    monkeypatch.setattr(runner_app, "get_session_agent_id", lambda _sid: "ag_parent")
    monkeypatch.setattr(runner_app, "register_child_session", lambda *a, **k: None)

    # Simulate a cold runner process: no inbox was ever registered for
    # this conversation (the normal `_initialize_session` path never ran
    # for it on this process).
    assert conversation_id not in runner_app._session_inboxes_ref

    async def _server_handler(request: httpx.Request) -> httpx.Response:
        """Serve fresh-create researcher-child lookup, create, and message POSTs."""
        if (
            request.method == "GET"
            and request.url.path == f"/v1/sessions/{conversation_id}/child_sessions"
        ):
            return httpx.Response(200, json={"data": []})
        if request.method == "POST" and request.url.path == "/v1/sessions":
            create_bodies.append(json.loads(request.content))
            return httpx.Response(201, json={"id": "conv_researcher_child"})
        if (
            request.method == "POST"
            and request.url.path == "/v1/sessions/conv_researcher_child/events"
        ):
            return httpx.Response(202, json={"queued": True})
        return httpx.Response(404, json={"error": str(request.url)})

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(_server_handler),
        base_url="http://server",
    ) as server_client:
        try:
            output = await execute_tool(
                tool_name="web_fetch",
                arguments=json.dumps({"query": "what is the weather in Boston"}),
                server_client=server_client,
                conversation_id=conversation_id,
                agent_spec=SimpleNamespace(sub_agents=[SimpleNamespace(name="__web_researcher")]),
                task_id="task_abc",
                # The dispatch site found no inbox for this conversation —
                # exactly what `_session_inboxes.get(conv_id)` returns on a
                # fresh runner process that never initialized this session.
                session_inbox=None,
            )
            registered_inbox = runner_app._session_inboxes_ref.get(conversation_id)
        finally:
            runner_app.unregister_subagent_work("conv_researcher_child")
            runner_app._session_inboxes_ref.pop(conversation_id, None)

    assert output != "Error: sys_session_send requires parent session inbox"
    assert isinstance(registered_inbox, asyncio.Queue), (
        "dispatch must self-heal by registering a queue for this conversation"
    )
    assert len(create_bodies) == 1, "web_fetch must spawn exactly one researcher child"
    payload = json.loads(output)
    assert payload["status"] == "launching"
    assert payload["agent"] == "__web_researcher"
