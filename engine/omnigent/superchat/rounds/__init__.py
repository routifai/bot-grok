"""Rounds (ADR 0029): what happened to one message from the person, recorded as it happened.

Layout: ``fold`` (the Round view, a pure fold over its events), ``store`` (the ``round_events``
table), ``record`` (the Round rule and the writers, called where the engine sees each fact).
Only Stop reads the record back so far; no tool, no route.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps, ToolManagerCtx

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    return []


def _install(_app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.server.routes._sessions.orchestration import ON_SESSION_DELETED
    from omnigent.superchat.rounds import record
    from omnigent.superchat.rounds.store import SqlAlchemyRoundStore

    if deps.storage_location is None:
        return
    store = SqlAlchemyRoundStore(deps.storage_location)
    record.RECORDER = record.Recorder(store)
    ON_SESSION_DELETED["rounds"] = store.delete_conversation


FEATURE = Feature(name="rounds", tools=_tools, install=_install)
