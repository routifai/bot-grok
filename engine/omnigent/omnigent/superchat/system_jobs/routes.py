"""``GET /v1/me/system-jobs``: the engine's own recurring background jobs, for the caller.

Read-only. Each job reports what it does in plain words, how often it runs, when it last ran for
this person and when it runs next, when the engine knows. Unknown times are ``null``.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, FastAPI, Request

from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.superchat.muse import muse_key


def _every(seconds: float) -> str:
    """Plain-words cadence, e.g. ``"Every hour"``."""
    if seconds % 3600 == 0:
        hours = int(seconds // 3600)
        return "Every hour" if hours == 1 else f"Every {hours} hours"
    if seconds % 60 == 0:
        minutes = int(seconds // 60)
        return "Every minute" if minutes == 1 else f"Every {minutes} minutes"
    return f"Every {int(seconds)} seconds"


def _next(last: int | None, interval: float) -> int | None:
    return None if last is None else int(last + interval)


def _last_upkeep_run(coordinator: Any, owner: str) -> int | None:
    runs = coordinator.upkeep_store.list_runs(owner, limit=1)
    if not runs:
        return None
    run = runs[0]
    return run.finished_at or run.started_at


def collect_jobs(app: FastAPI, owner: str, key: str) -> list[dict[str, Any]]:
    """Build the caller's job rows from what the server is running."""
    jobs: list[dict[str, Any]] = []

    coordinator = getattr(app.state, "memory_upkeep_coordinator", None)
    scheduler = getattr(app.state, "memory_upkeep_scheduler", None)
    interval = float(scheduler.sweep_interval_s) if scheduler is not None else 3600.0
    jobs.append(
        {
            "id": "memory_upkeep",
            "name": "Memory upkeep",
            "description": (
                "Reads your recent conversations and keeps what is worth remembering about you "
                "up to date: new facts, changed facts, and things you asked it to remember."
            ),
            "schedule": _every(interval) + ", and after a conversation is condensed",
            "last_run_at": _last_upkeep_run(coordinator, owner) if coordinator else None,
            "next_run_at": _next(getattr(scheduler, "last_sweep_at", None), interval),
            "enabled": coordinator is not None and scheduler is not None,
        }
    )

    sweeper = getattr(app.state, "side_chat_archive_sweeper", None)
    sweeper_interval = float(sweeper.interval_s) if sweeper is not None else 3600.0
    jobs.append(
        {
            "id": "side_chat_archiving",
            "name": "Side chat archiving",
            "description": (
                "Archives side chats you have not touched for a while, so your list stays tidy. "
                "You choose how long in the settings, or turn it off."
            ),
            "schedule": _every(sweeper_interval),
            "last_run_at": getattr(sweeper, "last_sweep_at", None),
            "next_run_at": _next(getattr(sweeper, "last_sweep_at", None), sweeper_interval),
            "enabled": sweeper is not None and sweeper.enabled_for(key),
        }
    )
    return jobs


def create_system_jobs_router(app: FastAPI, *, auth_provider: AuthProvider | None = None) -> APIRouter:
    """Build the router (mount with ``prefix="/v1"``)."""
    router = APIRouter()

    @router.get("/me/system-jobs")
    async def list_system_jobs(request: Request) -> dict[str, Any]:
        """The engine's recurring background jobs, with this person's last and next run."""
        user_id = require_user(request, auth_provider)
        owner = user_id or RESERVED_USER_LOCAL
        tenant = auth_provider.get_tenant(request) if auth_provider is not None else None
        jobs = await asyncio.to_thread(collect_jobs, app, owner, muse_key(owner, tenant))
        return {"jobs": jobs}

    return router
