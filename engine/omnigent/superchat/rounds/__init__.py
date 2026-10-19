"""Rounds (ADR 0029): what happened to one message from the person, recorded as it happened.

Layout: ``fold`` (the Round view, a pure fold over its events), ``store`` (the ``round_events``
table), ``record`` (the Round rule and the writers, called where the engine sees each fact).
A settled Round's journal entry goes to the host through the relay op :data:`JOURNAL_OP`, which
writes it with :func:`omnigent.runner.memory.sync.record_round`. No tool, no route reads the
record yet.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from omnigent.superchat.feature import (
    RELAY_MARK,
    Feature,
    HandlerCtx,
    InstallDeps,
    ToolManagerCtx,
    is_helper,
)

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool

_logger = logging.getLogger(__name__)

#: The relay op that journals a settled Round in the host; never offered to a model.
JOURNAL_OP = "round_journal"
JOURNAL_TIMEOUT_S = 10.0


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    return []


async def _journal_round(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """Runner side of :data:`JOURNAL_OP`: write the entry into the Conversation's journal."""
    from omnigent.runner.memory.sync import record_round

    if not ctx.conversation_id or is_helper(ctx.labels):
        return json.dumps({"error": "a Round is journaled by its Conversation"})
    return json.dumps({"written": await record_round(ctx.conversation_id, args)})


def _install(_app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.server.routes._sessions.common import get_server_runner_router
    from omnigent.server.routes._sessions.helpers import _get_runner_client
    from omnigent.server.routes._sessions.orchestration import ON_SESSION_DELETED
    from omnigent.superchat.rounds import record
    from omnigent.superchat.rounds.store import SqlAlchemyRoundStore

    if deps.storage_location is None:
        return

    async def journal(conversation_id: str, entry: dict[str, Any]) -> None:
        """Hand the entry to the Conversation's runner when it is connected; never wakes it."""
        client = await _get_runner_client(
            conversation_id, deps.runner_router or get_server_runner_router()
        )
        if client is None:
            _logger.info("round %s not journaled: no runner", entry["round_id"])
            return
        resp = await client.post(
            f"/v1/sessions/{conversation_id}/mcp/execute",
            json={
                "method": "tools/call",
                "params": {"name": JOURNAL_OP, "arguments": entry},
                RELAY_MARK: True,
            },
            timeout=JOURNAL_TIMEOUT_S,
        )
        if resp.status_code >= 400 or "error" in resp.json():
            _logger.warning("round %s not journaled: %s", entry["round_id"], resp.text[:300])

    store = SqlAlchemyRoundStore(deps.storage_location)
    record.RECORDER = record.Recorder(store, on_settled=journal)
    ON_SESSION_DELETED["rounds"] = store.delete_conversation


FEATURE = Feature(
    name="rounds",
    tools=_tools,
    handlers={JOURNAL_OP: _journal_round},
    relay_ops=frozenset({JOURNAL_OP}),
    install=_install,
)
