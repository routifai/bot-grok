"""What happens to artifacts, announced to the capabilities built on them.

A capability that follows files (the knowledge index) subscribes here instead of the artifact code
importing it. Listeners run synchronously in the thread that saved or deleted the file, so they
must be quick (write a row, wake a worker), and a failing listener never fails the save.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from omnigent.superchat.artifacts.store import Artifact

_logger = logging.getLogger(__name__)

#: ``(saved version, its bytes, ids of the deliverable's other versions)``
CreatedListener = Callable[["Artifact", bytes, Sequence[str]], None]
#: ``(every version of a deliverable that was deleted)``
DeletedListener = Callable[[Sequence["Artifact"]], None]

_created: list[CreatedListener] = []
_deleted: list[DeletedListener] = []


def subscribe_created(listener: CreatedListener) -> None:
    """Call *listener* after every saved artifact version (once per function object)."""
    if listener not in _created:
        _created.append(listener)


def subscribe_deleted(listener: DeletedListener) -> None:
    """Call *listener* after a deliverable and all its versions were deleted."""
    if listener not in _deleted:
        _deleted.append(listener)


def unsubscribe_all() -> None:
    """Drop every listener (tests)."""
    _created.clear()
    _deleted.clear()


def emit_created(item: Artifact, data: bytes, siblings: Sequence[str]) -> None:
    """Tell the listeners a version was saved."""
    for listener in tuple(_created):
        try:
            listener(item, data, siblings)
        except Exception:  # noqa: BLE001 - a listener must never fail the save
            _logger.warning("artifact created listener failed", exc_info=True)


def emit_deleted(items: Sequence[Artifact]) -> None:
    """Tell the listeners a deliverable was deleted."""
    for listener in tuple(_deleted):
        try:
            listener(items)
        except Exception:  # noqa: BLE001
            _logger.warning("artifact deleted listener failed", exc_info=True)
