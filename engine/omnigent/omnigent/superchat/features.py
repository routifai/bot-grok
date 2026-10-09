"""The ordered registry of Super Chat features and the three framework seams that read it.

Add a primitive by creating ``omnigent/superchat/<name>/`` with a ``FEATURE`` and listing it
here; ``tools/manager.py``, ``runner/tool_dispatch.py`` and ``server/app.py`` need no change.
"""

from __future__ import annotations

import inspect
from collections.abc import Mapping
from typing import TYPE_CHECKING

from omnigent.superchat.feature import (
    BackgroundJob,
    Feature,
    Handler,
    HandlerCtx,
    InstallDeps,
    ToolManagerCtx,
)

if TYPE_CHECKING:
    from fastapi import FastAPI

    from omnigent.tools.base import Tool


def _load() -> list[Feature]:
    """Import each feature folder (order is registration order)."""
    from omnigent.superchat.admin import FEATURE as admin
    from omnigent.superchat.approvals import FEATURE as approvals
    from omnigent.superchat.apps import FEATURE as apps
    from omnigent.superchat.artifacts import ARTIFACTS_FEATURE as artifacts
    from omnigent.superchat.cards import FEATURE as cards
    from omnigent.superchat.daily_notes import FEATURE as daily_notes
    from omnigent.superchat.family import FEATURE as family
    from omnigent.superchat.feed import FEATURE as feed
    from omnigent.superchat.goals import FEATURE as goals
    from omnigent.superchat.helpers import FEATURE as helpers
    from omnigent.superchat.ideas import FEATURE as ideas
    from omnigent.superchat.memory import FEATURE as memory
    from omnigent.superchat.models import FEATURE as models
    from omnigent.superchat.projects import FEATURE as projects
    from omnigent.superchat.sheets import FEATURE as sheets
    from omnigent.superchat.side_chats import FEATURE as side_chats
    from omnigent.superchat.skills import FEATURE as skills
    from omnigent.superchat.step_limit import FEATURE as step_limit
    from omnigent.superchat.transcript import FEATURE as transcript
    from omnigent.superchat.vault import FEATURE as vault

    return [
        approvals,
        vault,
        models,
        admin,
        ideas,
        goals,
        skills,
        daily_notes,
        cards,
        memory,
        artifacts,
        apps,
        sheets,
        side_chats,
        helpers,
        projects,
        step_limit,
        transcript,
        family,
        feed,
    ]


FEATURES: list[Feature] = _load()

#: ``tool_name -> handler`` over every feature, consulted by the runner dispatch.
FEATURE_HANDLERS: dict[str, Handler] = {
    name: handler for feature in FEATURES for name, handler in feature.handlers.items()
}


def notify_result(ctx: HandlerCtx, output: str) -> None:
    """Tell every feature that listens (``Feature.on_result``) what a handler just returned."""
    for feature in FEATURES:
        if feature.on_result is not None:
            feature.on_result(ctx, output)


def feature_tools(labels: Mapping[str, str] | None, ctx: ToolManagerCtx) -> list[Tool]:
    """Every feature's label-gated tool defs, in feature order."""
    return [tool for feature in FEATURES for tool in feature.tools(labels, ctx)]


def install_features(app: FastAPI, deps: InstallDeps) -> None:
    """Wire every feature's store and router onto ``app``."""
    for feature in FEATURES:
        if feature.install is not None:
            feature.install(app, deps)


def feature_jobs(app: FastAPI) -> list[BackgroundJob]:
    """Every feature's background jobs (call once the app's lifespan state is ready)."""
    return [job for feature in FEATURES if feature.jobs for job in feature.jobs(app)]


async def start_feature_jobs(app: FastAPI) -> None:
    """Build every feature's jobs and start them (lifespan startup)."""
    app.state.feature_jobs = feature_jobs(app)
    for job in app.state.feature_jobs:
        result = job.start()
        if inspect.isawaitable(result):
            await result


async def stop_feature_jobs(app: FastAPI) -> None:
    """Shut down the jobs :func:`start_feature_jobs` started (lifespan shutdown)."""
    for job in reversed(getattr(app.state, "feature_jobs", [])):
        result = job.shutdown()
        if inspect.isawaitable(result):
            await result
