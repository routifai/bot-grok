"""Feed: the topics the Muse follows for the person and what their runs found.

Layout: ``topics`` (what counts as a followed topic, the ``nothing_new`` rule, post shaping),
``routes`` (``/v1/me/topics`` and ``/v1/me/feed``), this module (registration).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from omnigent.superchat.feature import Feature, InstallDeps

if TYPE_CHECKING:
    from fastapi import FastAPI


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.superchat.feed.routes import create_feed_router

    if deps.scheduled_task_store is None:
        return
    app.include_router(
        create_feed_router(
            scheduled_task_store=deps.scheduled_task_store,
            conversation_store=deps.conversation_store,
            auth_provider=deps.auth_provider,
        ),
        prefix="/v1",
        tags=["feed"],
    )


FEATURE = Feature(name="feed", tools=lambda _labels, _ctx: [], install=_install)
