"""Topic watch: what changed in the person's sources that moves one of their topics (ADR 0035).

Layout: ``rules`` (noise, match and decide; pure), ``judge`` (the Light-model call's prompt,
input and validation; pure), ``notice`` (what a message-now item puts in the Conversation),
``sources`` (the stage 2 adapters), ``store`` (cursors, seen-set, run records), ``service``
(the hidden task per person and the run). No tools: the run is engine code past the scheduled
path's gates, and only an item worth saying now reaches the Conversation.

Topics, marks and mutes belong to other capabilities; ``service.SEAM_PATHS`` names where each is
read from, resolved at each run.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from omnigent.superchat.feature import BackgroundJob, Feature, InstallDeps, ToolManagerCtx
from omnigent.superchat.topic_watch.notice import reminder_for

if TYPE_CHECKING:
    import httpx
    from fastapi import FastAPI

    from omnigent.superchat.feature import MessageBlock
    from omnigent.tools.base import Tool


def _tools(_labels: Mapping[str, str] | None, _ctx: ToolManagerCtx) -> list[Tool]:
    return []


async def _message_prefix(
    _client: httpx.AsyncClient | None, _conversation_id: str, texts: Sequence[str]
) -> list[MessageBlock]:
    """The reminder for a turn a topic watch notice woke; nothing for any other turn."""
    reminder = reminder_for(texts)
    return [reminder] if reminder else []


def _install(app: FastAPI, deps: InstallDeps) -> None:
    from omnigent.runtime import get_artifact_store
    from omnigent.server.scheduled.helper_fire import register_engine_run
    from omnigent.superchat.topic_watch.service import TASK_KIND, TopicWatch
    from omnigent.superchat.topic_watch.sources import FilesSource, UnconnectedSource, WebSource
    from omnigent.superchat.topic_watch.store import SqlAlchemyTopicWatchStore

    if deps.scheduled_task_store is None or deps.storage_location is None:
        return
    store = SqlAlchemyTopicWatchStore(deps.storage_location)

    def read_blob(key: str) -> bytes:
        blobs = get_artifact_store()
        if blobs is None:
            raise RuntimeError("artifact blob store is not configured")
        return blobs.get(key)

    watch = TopicWatch(
        store=store,
        tasks=deps.scheduled_task_store,
        conversations=deps.conversation_store,
        sources=[
            UnconnectedSource("mail"),
            UnconnectedSource("calendar"),
            FilesSource(store.file_versions_since, read_blob),
            WebSource(),
        ],
        scheduler=lambda: getattr(app.state, "scheduled_task_scheduler", None),
        fire_deps=lambda: getattr(app.state, "fire_deps", None),
    )
    register_engine_run(TASK_KIND, watch.run)
    app.state.topic_watch = watch


def _jobs(app: FastAPI) -> list[BackgroundJob]:
    """The ticker that keeps one hidden task per person, when the app has a scheduler."""
    watch = getattr(app.state, "topic_watch", None)
    if watch is None or getattr(app.state, "scheduled_task_scheduler", None) is None:
        return []
    return [watch]


FEATURE = Feature(
    name="topic_watch",
    tools=_tools,
    message_prefix=_message_prefix,
    conversation_only=True,
    install=_install,
    jobs=_jobs,
)
