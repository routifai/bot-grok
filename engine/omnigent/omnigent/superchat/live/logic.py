"""What a live update may change: the rules of ``docs/live-artifacts.md`` as a pure function.

Per change: apply it, turn it into a suggestion (the person owns that part now), skip it (the
person undid that value, or deleted the part) or report it unplaced.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from omnigent.superchat.artifacts.patches import PatchError, SetText, apply_patches, read_text


def _norm(text: str) -> str:
    return " ".join(text.split())


@dataclass
class Plan:
    """The outcome of one run, before anything is stored."""

    data: bytes
    written: dict[str, str]
    rejected: list[list[str]]
    applied: list[dict[str, Any]] = field(default_factory=list)
    suggestions: list[dict[str, Any]] = field(default_factory=list)
    unplaced: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)


def plan_changes(data: bytes, changes: list[dict[str, Any]], state: dict[str, Any]) -> Plan:
    """Decide what each ``{id, after, source?, notable?}`` does to the newest bytes ``data``."""
    plan = Plan(data, dict(state["written"]), list(state["rejected"]))
    for change in changes:
        ident, after, source = str(change["id"]), str(change["after"]), change.get("source")
        if [ident, after] in plan.rejected:
            continue
        try:
            current = read_text(plan.data, ident)
        except PatchError:
            plan.unplaced.append(ident)
            continue
        if current is None:  # the person deleted a part an update wrote, or the id is wrong
            (plan.removed if ident in plan.written else plan.unplaced).append(ident)
        elif _norm(current) == _norm(after):
            plan.written[ident] = after
        elif ident in plan.written and _norm(current) != _norm(plan.written[ident]):
            plan.suggestions.append(
                {"id": ident, "yours": current, "source_value": after, "source": source}
            )
        else:
            try:
                plan.data, _ = apply_patches(
                    plan.data, [SetText(kind="set-text", id=ident, text=after)]
                )
            except PatchError:
                plan.unplaced.append(ident)
                continue
            notable = bool(change.get("notable"))
            plan.applied.append(
                {
                    "id": ident,
                    "before": current,
                    "after": after,
                    "source": source,
                    "notable": notable,
                }
            )
            plan.written[ident] = after
            plan.rejected = [r for r in plan.rejected if r[0] != ident]
    return plan
