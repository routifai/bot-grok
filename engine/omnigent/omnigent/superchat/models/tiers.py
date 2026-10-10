"""A person's two model picks per harness: **Default** (chats) and **Light** (quick work).

Both come from the person's own catalog for the harness (what their connection serves), never
from a model name in configuration, and both are chosen automatically until the person picks one
in Settings, Models (stored in :class:`~omnigent.superchat.models.selection.ModelPreferenceStore`):

* **Default**: their pick when the catalog still serves it, else the catalog's default.
* **Light**: their pick when the catalog still serves it, else the cheapest catalog model by its
  price (input price, then output price; the price the connection reports for the model, else
  the shared model catalog's), else the catalog's default when nothing is priced.

A Super Chat Helper names only ``fast`` or ``strong``: ``fast`` runs on Light, ``strong`` on
Default. Background work (memory upkeep, the daily note, Dreaming, side-chat seeds, reranking)
runs on Light (:mod:`.background`). The runner (inside a Computer, no database) asks
``GET /v1/sessions/{id}/helper-models`` (:mod:`.selection`).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from omnigent.errors import OmnigentError
from omnigent.inference_config import normalize_inference_harness

_logger = logging.getLogger(__name__)

#: The two choices a Helper dispatch may name, and which of the person's picks each runs on.
TIER_PICKS = {"fast": "light", "strong": "default"}

Price = tuple[float, float]


@dataclass(frozen=True)
class PersonModels:
    """One person's effective models on one harness (``None``: the catalog is not usable)."""

    default: str | None
    light: str | None
    #: What the person picked themselves (``None``: automatic).
    default_pick: str | None = None
    light_pick: str | None = None
    #: What Light is when the person has not picked one.
    automatic_light: str | None = None


def catalog_price(model: str) -> Price | None:
    """``(input, output)`` USD per token from the shared model catalog, or ``None``. Blocking."""
    from omnigent.llms.context_window import fetch_model_pricing

    try:
        pricing = fetch_model_pricing(model)
    except Exception:  # noqa: BLE001 - an unreachable catalog only means "unpriced"
        return None
    return (pricing.input_per_token, pricing.output_per_token) if pricing is not None else None


def row_price(row: Mapping[str, Any], fallback: Callable[[str], Price | None]) -> Price | None:
    """The price the connection reported for a catalog *row*, else *fallback* (the catalog's)."""
    reported = row.get("costPerToken")
    if isinstance(reported, Mapping):
        given, out = reported.get("input"), reported.get("output")
        if isinstance(given, (int, float)) and not isinstance(given, bool):
            if not isinstance(out, (int, float)) or isinstance(out, bool):
                out = float("inf")
            return float(given), float(out)
    return fallback(row["id"])


def cheapest_model(
    rows: Sequence[Mapping[str, Any]],
    default: str | None,
    price: Callable[[str], Price | None] | None = None,
) -> str | None:
    """The cheapest model of a ready catalog's *rows*: lowest input price, ties broken by the
    output price, then by catalog order. *default* when no row is priced. Blocking."""
    lookup = price or catalog_price
    priced = [
        (cost, index, row["id"])
        for index, row in enumerate(rows)
        if (cost := row_price(row, lookup)) is not None
    ]
    if not priced:
        return default if default is not None else (rows[0]["id"] if rows else None)
    return min(priced)[2]


def person_models_from_catalog(
    catalog: Mapping[str, Any],
    *,
    default_pick: str | None,
    light_pick: str | None,
    price: Callable[[str], Price | None] | None = None,
) -> PersonModels:
    """Resolve Default and Light from a catalog and the person's saved picks. Blocking."""
    if catalog.get("status") != "ready":
        return PersonModels(None, None, default_pick, light_pick)
    rows = catalog.get("models") or []
    served = {row["id"] for row in rows}
    catalog_default = catalog.get("default_model") or (rows[0]["id"] if rows else None)
    automatic = cheapest_model(rows, catalog_default, price)
    return PersonModels(
        default=default_pick if default_pick in served else catalog_default,
        light=light_pick if light_pick in served else automatic,
        default_pick=default_pick,
        light_pick=light_pick,
        automatic_light=automatic,
    )


def _owner(owner: str | None) -> str:
    from omnigent.server.auth import RESERVED_USER_LOCAL

    return owner or RESERVED_USER_LOCAL


async def person_models(app_state: Any, owner: str | None, harness: str) -> PersonModels:
    """*owner*'s Default and Light on *harness*, from the catalog a new session would get."""
    from omnigent.server.inference_catalog import SandboxInferenceService

    harness = normalize_inference_harness(harness)
    service = getattr(app_state, "inference_catalog", None) or SandboxInferenceService(app_state)
    try:
        snapshot = await service.prepare(None, harness, owner)
    except (OmnigentError, ValueError) as exc:
        # No key, no reachable catalog: nothing to resolve yet.
        _logger.info("no models for %s: %s", harness, type(exc).__name__)
        snapshot = None
    catalog = (snapshot or {}).get("catalog") or {}
    store = getattr(app_state, "model_preference_store", None)
    picks = await asyncio.to_thread(store.read, _owner(owner)) if store is not None else None
    return await asyncio.to_thread(
        person_models_from_catalog,
        catalog,
        default_pick=(picks.defaults.get(harness) if picks else None),
        light_pick=(picks.light.get(harness) if picks else None),
    )


async def tier_models(
    app_state: Any, owner: str | None, harness: str | None
) -> dict[str, str | None]:
    """``{"fast": Light, "strong": Default}`` for *owner* on *harness* (``None``: inherit)."""
    if not harness or app_state is None:
        return dict.fromkeys(TIER_PICKS)
    models = await person_models(app_state, owner, harness)
    return {tier: getattr(models, pick) for tier, pick in TIER_PICKS.items()}
