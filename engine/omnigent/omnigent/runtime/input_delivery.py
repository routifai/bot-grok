"""How the messages sent to a running session were taken: steered into the turn, or queued.

The runner reports it with ``session.input.delivery`` (see ``SessionInputDeliveryEvent``); the
server records it here so a client that loads the transcript later sees the same state on the
message (``delivered``). Memory only and bounded: it describes messages sent during a turn, which
matter for seconds. A ``queued`` message counts only while the session is running or just
stopped (a stop drops the queue without telling anyone).
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict

#: Messages remembered per session.
_MAX_PER_SESSION = 50
#: How long a ``queued`` message still counts after the session stopped running.
QUEUED_GRACE_S = 10.0

_lock = threading.Lock()
_by_session: dict[str, OrderedDict[str, tuple[str, float]]] = {}


def record(session_id: str, item_id: str, delivered: str, *, now: float | None = None) -> None:
    """Remember how *item_id* was taken (``steer`` / ``queued``); ``turn`` forgets a queued one."""
    stamp = time.monotonic() if now is None else now
    with _lock:
        entries = _by_session.setdefault(session_id, OrderedDict())
        if delivered == "turn":
            entries.pop(item_id, None)
            return
        entries[item_id] = (delivered, stamp)
        entries.move_to_end(item_id)
        while len(entries) > _MAX_PER_SESSION:
            entries.popitem(last=False)


def delivered_for(
    session_id: str, *, session_running: bool, now: float | None = None
) -> dict[str, str]:
    """``{item id: "steer" | "queued"}`` for the messages of *session_id* worth showing."""
    stamp = time.monotonic() if now is None else now
    with _lock:
        entries = list(_by_session.get(session_id, {}).items())
    return {
        item_id: delivered
        for item_id, (delivered, at) in entries
        if delivered == "steer" or session_running or stamp - at < QUEUED_GRACE_S
    }


def forget(session_id: str) -> None:
    """Drop everything remembered for *session_id* (it was deleted)."""
    with _lock:
        _by_session.pop(session_id, None)
