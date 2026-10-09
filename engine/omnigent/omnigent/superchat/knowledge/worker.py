"""The indexing worker: one asyncio task, one job at a time, like the memory upkeep.

It lives in the engine process (not the Computer). It takes the oldest due job, runs the pass in a
thread and records a failure with a growing retry delay. ``wake`` (called when a file is saved)
ends its idle wait early.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

from omnigent.db.utils import now_epoch
from omnigent.superchat.knowledge.service import KnowledgeService

_logger = logging.getLogger(__name__)

#: Longest idle wait: a job saved by another process, or a retry coming due, is noticed by then.
IDLE_SECONDS = 15.0


class IndexWorker:
    """Background job (``start()`` / ``shutdown()``) that indexes queued files."""

    def __init__(self, service: KnowledgeService, *, idle_seconds: float = IDLE_SECONDS) -> None:
        self._service = service
        self._idle = idle_seconds
        self._task: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wakeup = asyncio.Event()

    def start(self) -> None:
        """Start the loop on the running event loop (once)."""
        if self._task is not None and not self._task.done():
            return
        self._loop = asyncio.get_running_loop()
        self._service.set_wake(self.wake)
        self._task = asyncio.create_task(self._run(), name="knowledge-index-worker")

    def wake(self) -> None:
        """Ask the loop to look for work now (safe from any thread)."""
        if self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._wakeup.set)

    async def _run(self) -> None:
        while True:
            try:
                job = await asyncio.to_thread(self._service.store.next_due)
                if job is None:
                    self._wakeup.clear()
                    with suppress(TimeoutError):
                        await asyncio.wait_for(self._wakeup.wait(), timeout=await self._sleep())
                    continue
                try:
                    await asyncio.to_thread(self._service.process, job)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001 - a bad file must not stop the worker
                    _logger.warning(
                        "file index failed artifact=%s (%s)", job.artifact_id, type(exc).__name__
                    )
                    await asyncio.to_thread(self._service.record_failure, job, exc)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the database being briefly unavailable
                _logger.warning("knowledge worker loop error", exc_info=True)
                await asyncio.sleep(self._idle)

    async def _sleep(self) -> float:
        """Seconds to wait: until the next retry is due, at most the idle time."""
        due = await asyncio.to_thread(self._service.store.next_retry_at)
        if due is None:
            return self._idle
        return max(0.1, min(self._idle, due - now_epoch()))

    async def wait_for_idle(self, timeout: float = 30.0) -> None:
        """Wait until no job is due (focused tests)."""
        async with asyncio.timeout(timeout):
            while True:
                due = await asyncio.to_thread(self._service.store.next_due)
                if due is None:
                    return
                await asyncio.sleep(0.05)

    async def shutdown(self) -> None:
        """Cancel the loop and wait for it."""
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
