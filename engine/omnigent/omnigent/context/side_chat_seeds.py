"""Side Chat seeds written in the background, and the wait a message makes for one.

Opening a ``with_context`` Side Chat (or a Fork, ADR 0010) returns as soon as the copy exists;
its seed checkpoint (a model-written summary) is built afterwards. A message posted to the chat
meanwhile waits here for the seed, so the seed always lands before the chat's first own message
(the runner rebuilds history from the latest compaction: a seed stored after the message would
hide it). The seed task bounds itself (``routes_core._seed_rollover_side_chat``), so the wait
ends on success and failure alike; a failed seed leaves the existing fallback in place.

One process, one event loop: the server runs the seed and the message in the same loop.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

_logger = logging.getLogger(__name__)

#: Longest a seed's summary may take before the chat keeps its fallback (and messages go on).
SIDE_CHAT_SEED_TIMEOUT_S = 120.0

_seeds: dict[str, asyncio.Task[None]] = {}


def start_seed(conversation_id: str, seed: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
    """Run *seed* in the background for *conversation_id*; messages to it wait for it.

    :param conversation_id: The new Side Chat.
    :param seed: Writes the seed. It must bound its own duration and never raise.
    :returns: The running task.
    """
    task = asyncio.create_task(seed, name=f"side-chat-seed-{conversation_id}")
    _seeds[conversation_id] = task

    def _forget(done: asyncio.Task[None]) -> None:
        if _seeds.get(conversation_id) is done:
            del _seeds[conversation_id]
        if not done.cancelled() and done.exception() is not None:
            _logger.warning(
                "side chat seed task for %s raised", conversation_id, exc_info=done.exception()
            )

    task.add_done_callback(_forget)
    return task


def seed_pending(conversation_id: str) -> bool:
    """Whether *conversation_id*'s seed is still being written."""
    task = _seeds.get(conversation_id)
    return task is not None and not task.done()


async def wait_for_seed(conversation_id: str) -> None:
    """Return once *conversation_id* has no seed being written (at once when it never had one).

    The caller's own cancellation never cancels the seed.
    """
    task = _seeds.get(conversation_id)
    if task is not None and not task.done():
        await asyncio.wait({task})
