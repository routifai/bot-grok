"""The vocabulary every capability shares to flag an action the person is asked about first.

A capability that owns a risky tool (delete a file, publish an app) registers a classifier here;
``approvals.policy`` reads them. Kept out of ``approvals`` so a capability never imports another.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Risk:
    """One recognised risky action.

    :param category: One of :data:`CATEGORIES`.
    :param targets: Who or what it touches (recipients, host, path, tool); a standing rule must
        cover every one.
    :param summary: One plain sentence for the person.
    :param amount_usd: What it would cost, when the call says so.
    """

    category: str
    targets: tuple[str, ...]
    summary: str
    amount_usd: float | None = None


Classifier = Callable[[str, Mapping[str, Any]], Risk | None]

_extra_classifiers: list[Classifier] = []


def register_classifier(classifier: Classifier) -> None:
    """Add a recogniser for a tool family (an email or payments connector, say).

    :param classifier: ``(tool_name, arguments) -> Risk | None``; ``None`` means "not mine".
    """
    if classifier not in _extra_classifiers:
        _extra_classifiers.append(classifier)
