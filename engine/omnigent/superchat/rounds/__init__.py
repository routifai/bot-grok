"""Rounds (ADR 0029): what happened to one message from the person, recorded as it happened.

Layout: ``fold`` (the Round view, a pure fold over its events), ``store`` (the ``round_events``
table), ``record`` (the Round rule and the writers, called where the engine sees each fact),
``read`` (what reads a Round once its events are stored: the family stream's ``round.updated``
and the development shadow diff), ``routes`` (the Round reads). No tool reads the record.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.superchat.rounds.store import RoundEvent
    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    return []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from fastapi import APIRouter

    from omnigent.server.routes._sessions.orchestration import ON_SESSION_DELETED
    from omnigent.superchat.rounds import record
    from omnigent.superchat.rounds.read import Announcer, Shadow, shadow_on
    from omnigent.superchat.rounds.routes import register_round_routes
    from omnigent.superchat.rounds.store import SqlAlchemyRoundStore

    if deps.storage_location is None:
        return
    store = SqlAlchemyRoundStore(deps.storage_location)
    readers = [Announcer(store)]
    if shadow_on():
        readers.append(Shadow(store, deps.conversation_store))

    def written(batch: Sequence[RoundEvent]) -> None:
        for reader in readers:
            reader.written(batch)

    record.RECORDER = record.Recorder(store, on_written=written)
    ON_SESSION_DELETED["rounds"] = store.delete_conversation
    router = APIRouter()
    register_round_routes(
        router,
        store=store,
        conversation_store=deps.conversation_store,
        auth_provider=deps.auth_provider,
        permission_store=deps.permission_store,
    )
    app.include_router(router, prefix="/v1", tags=["rounds"])


FEATURE = Feature(name="rounds", tools=_tools, install=_install)
