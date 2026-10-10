"""The organization's Helper tiers: which model ``fast`` and ``strong`` mean, per harness.

A Super Chat dispatch names only ``fast`` or ``strong`` (never a model); the organization's admin
picks the model behind each in Settings, Models, from the connection's own list (stored in the
model overlay, :mod:`omnigent.superchat.models.org`). Nothing is configured by name: a tier with
no pick means "inherit the parent session's model", which is the connection's default model when
nothing else was chosen.

Server code reads the tiers through :func:`tier_model`; the runner (inside a Computer, no
database) asks ``GET /v1/sessions/{id}/helper-models`` (:mod:`.selection`).
"""

from __future__ import annotations

from omnigent.inference_config import normalize_inference_harness
from omnigent.superchat.models.org import TIERS, ModelOrgOverlayStore

__all__ = [
    "TIERS",
    "bind_overlay",
    "get_overlay_store",
    "org_fast_model",
    "tier_model",
    "tier_models",
]

_overlay: ModelOrgOverlayStore | None = None


def bind_overlay(store: ModelOrgOverlayStore | None) -> None:
    """Bind the server's overlay store so server code can read the tiers (``None`` unbinds)."""
    global _overlay
    _overlay = store


def get_overlay_store() -> ModelOrgOverlayStore | None:
    """The bound overlay store, or ``None`` when the server has none."""
    return _overlay


def tier_models(harness: str | None) -> dict[str, str | None]:
    """``{"fast": id | None, "strong": id | None}`` the organization picked for *harness*.

    Blocking (reads the database): call it from a thread in async code.
    """
    store = _overlay
    entry = (
        store.get().get(normalize_inference_harness(harness))
        if store is not None and harness
        else None
    )
    return {tier: (entry or {}).get(tier) for tier in TIERS}


def tier_model(tier: str, harness: str | None) -> str | None:
    """The model the organization picked for *tier* on *harness*, or ``None`` (not chosen)."""
    return tier_models(harness).get(tier)


def org_fast_model() -> str | None:
    """The organization's fast pick on any harness (the first one picked), or ``None``.

    For work that is not tied to a harness, like reranking search hits. Blocking.
    """
    store = _overlay
    if store is None:
        return None
    return next((entry["fast"] for entry in store.get().values() if entry.get("fast")), None)
