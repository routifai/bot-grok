"""Transcript: a session's items projected into typed chat blocks (``GET .../transcript``).

Layout: ``blocks`` (the pure projection), ``routes`` (the route, paging, the reset cut,
lineage), ``reset`` (``POST .../reset``: clear a Super Chat), this module (registration).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps

if TYPE_CHECKING:
    from fastapi import FastAPI


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from fastapi import APIRouter

    from omnigent.runtime import get_artifact_store
    from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
    from omnigent.superchat.transcript.reset import register_reset_routes
    from omnigent.superchat.transcript.routes import register_transcript_routes

    router = APIRouter()
    common = {
        "conversation_store": deps.conversation_store,
        "auth_provider": deps.auth_provider,
        "permission_store": deps.permission_store,
    }
    register_transcript_routes(
        router,
        **common,
        # The person's messages carry the artifact they are about (docs/conversation.md).
        artifact_store=SqlAlchemyArtifactStore(
            deps.scheduled_task_store.storage_location, get_artifact_store
        )
        if deps.scheduled_task_store is not None
        else None,
    )
    register_reset_routes(router, **common)
    app.include_router(router, prefix="/v1", tags=["transcript"])


FEATURE = Feature(name="transcript", tools=lambda _labels, _ctx: [], install=_install)
