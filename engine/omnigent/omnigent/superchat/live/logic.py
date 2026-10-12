"""What a live update may change: the rules of ``docs/live-artifacts.md`` as a pure function.

Given the newest bytes of a page, the changes a Helper found in the sources and what earlier
updates remember, decide per change: apply it, turn it into a suggestion (the person owns that
part now), skip it (the person undid it) or report it (it cannot be placed).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from omnigent.superchat.artifacts.patches import PatchError, SetText, apply_patches, read_text


def norm(text: str) -> str:
    """Text as compared for ownership: whitespace collapsed."""
    return " ".join(text.split())


@dataclass
class Plan:
    """The outcome of one save, before anything is stored."""

    data: bytes
    applied: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[dict[str, Any]] = field(default_factory=list)
    unplaced: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    written: dict[str, str] = field(default_factory=dict)
    rejected: list[list[str]] = field(default_factory=list)


def plan_changes(data: bytes, changes: list[dict[str, Any]], state: dict[str, Any]) -> Plan:
    """Decide what each ``{id, after, source, notable?}`` change does to the page.

    :param data: The newest version's bytes.
    :param changes: The changes the Helper found.
    :param state: The live state (``written``, ``rejected``).
    """
    plan = Plan(data=data, written=dict(state["written"]), rejected=list(state["rejected"]))
    for change in changes:
        ident, after = str(change["id"]), str(change["after"])
        if [ident, after] in plan.rejected:
            continue
        try:
            current = read_text(plan.data, ident)
        except PatchError:
            plan.unplaced.append(ident)
            continue
        if current is None:  # gone from the page: the person deleted it, or the id is wrong
            (plan.removed if ident in plan.written else plan.unplaced).append(ident)
            continue
        if norm(current) == norm(after):  # the page already shows it
            plan.written[ident] = after
            continue
        if ident in plan.written and norm(current) != norm(plan.written[ident]):
            plan.suggestions.append(
                {
                    "id": ident,
                    "yours": current,
                    "source_value": after,
                    "source": change.get("source"),
                }
            )
            continue
        try:
            plan.data, _ = apply_patches(
                plan.data, [SetText(kind="set-text", id=ident, text=after)]
            )
        except PatchError:
            plan.unplaced.append(ident)
            continue
        plan.applied.append(
            {
                "id": ident,
                "before": current,
                "after": after,
                "source": change.get("source"),
                "notable": bool(change.get("notable")),
            }
        )
        plan.written[ident] = after
        plan.rejected = [r for r in plan.rejected if r[0] != ident]
    return plan
