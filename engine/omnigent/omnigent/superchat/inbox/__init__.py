"""Decisions inbox: everything waiting on the person, as one list (``/v1/me/asks``).

Layout: ``asks`` (the pure shaping and id encoding), ``routes`` (list + answer, dispatching to
the approval and objective stores), this module (registration).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps

if TYPE_CHECKING:
    from fastapi import FastAPI


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.inbox.routes import create_asks_router

    app.include_router(
        create_asks_router(
            objective_store=deps.objective_store,
            conversation_store=deps.conversation_store,
            agent_store=deps.agent_store,
            runner_router=deps.runner_router,
            permission_store=deps.permission_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["asks"],
    )


FEATURE = Feature(name="inbox", tools=lambda _labels, _ctx: [], install=_install)
