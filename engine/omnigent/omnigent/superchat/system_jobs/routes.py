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
    jobs.extend(_note_jobs(app, owner))
    return jobs


def _note_jobs(app: FastAPI, owner: str) -> list[dict[str, Any]]:
    """The quiet-moment worker's three passes: Daily note, Dreaming and People."""
    from omnigent.superchat.daily_notes import quiet_moment as qm

    worker = getattr(app.state, "quiet_moment", None)
    store = getattr(app.state, "daily_note_store", None)
    notes = []
    if store is not None:
        user_id = None if owner == RESERVED_USER_LOCAL else owner
        notes = store.list_range(store.owner_key(user_id), date_from=None, date_to=None, limit=14)
    enabled = worker is not None

    def latest(column: str) -> int | None:
        stamps = [getattr(n, column) for n in notes if getattr(n, column)]
        return max(stamps) if stamps else None

    passes = [n.updated_at for n in notes if n.quiet_passes > 0]
    last_note = max([*passes, *(n.finalized_at for n in notes if n.finalized_at)], default=None)
    idle_minutes = int(qm.idle_seconds() // 60)
    evening = f"{qm.FINALIZE_HOUR}:00"
    nightly = f"about {qm.NIGHTLY_DELAY_SECONDS // 60} minutes after the day's final note"
    return [
        {
            "id": "daily_note",
            "name": "Daily note",
            "description": (
                "Keeps a short note of each day: what you talked about, what was decided and "
                "promised, and what is still open. It also saves lasting facts about you to memory."
            ),
            "schedule": (
                f"After a chat has been quiet {idle_minutes} minutes (up to {qm.MAX_PASSES_PER_DAY}"
                f" times a day), and a final pass at {evening}"
            ),
            "last_run_at": last_note,
            "next_run_at": None,
            "enabled": enabled,
        },
        {
            "id": "dreaming",
            "name": "Dreaming",
            "description": (
                "Reflects on how the day went (what worked, what did not) and adjusts how it "
                "works with you from what you said."
            ),
            "schedule": f"Nightly, {nightly}",
            "last_run_at": latest("dreamed_at"),
            "next_run_at": None,
            "enabled": enabled,
        },
        {
            "id": "people",
            "name": "People",
            "description": (
                "Keeps one short page in memory for each person or group you mention, with the "
                "key facts and when you said them."
            ),
            "schedule": f"Nightly, {nightly}",
            "last_run_at": latest("people_at"),
            "next_run_at": None,
            "enabled": enabled,
        },
    ]


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
