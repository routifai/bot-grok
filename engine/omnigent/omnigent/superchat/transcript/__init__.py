"""Transcript: a session's items projected into typed chat blocks (``GET .../transcript``).

Layout: ``blocks`` (the pure projection), ``routes`` (the route, paging, seed cut, lineage),
this module (registration).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps

if TYPE_CHECKING:
    from fastapi import FastAPI


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from fastapi import APIRouter

    from omnigent.superchat.transcript.routes import register_transcript_routes

    router = APIRouter()
    register_transcript_routes(
        router,
        conversation_store=deps.conversation_store,
        auth_provider=deps.auth_provider,
        permission_store=deps.permission_store,
    )
    app.include_router(router, prefix="/v1", tags=["transcript"])


FEATURE = Feature(name="transcript", tools=lambda _labels, _ctx: [], install=_install)
