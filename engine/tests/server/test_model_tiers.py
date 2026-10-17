"""Default and Light: how a person's two models resolve from their catalog."""

from __future__ import annotations

from omnigent.superchat.models.tiers import cheapest_model, person_models_from_catalog

PRICES = {
    "big": (3e-6, 15e-6),
    "small": (1e-6, 5e-6),
    "small-chatty": (1e-6, 8e-6),
}


def _catalog(*ids: str, default: str | None = None) -> dict:
    return {
        "status": "ready",
        "default_model": default or ids[0],
        "models": [{"id": model} for model in ids],
    }


def test_cheapest_is_the_lowest_input_price_then_output_price() -> None:
    rows = _catalog("big", "small-chatty", "small")["models"]
    assert cheapest_model(rows, "big", PRICES.get) == "small"
    # Unpriced rows never win over priced ones.
    rows = _catalog("mystery", "big")["models"]
    assert cheapest_model(rows, "mystery", PRICES.get) == "big"


def test_a_price_the_connection_reports_beats_the_shared_catalog() -> None:
    rows = [
        {"id": "big", "costPerToken": {"input": 1e-7, "output": 1e-7}},
        {"id": "small"},
    ]
    assert cheapest_model(rows, "small", PRICES.get) == "big"


def test_no_pricing_falls_back_to_the_catalog_default() -> None:
    rows = _catalog("a", "b", default="b")["models"]
    assert cheapest_model(rows, "b", lambda _m: None) == "b"
    assert cheapest_model(rows, None, lambda _m: None) == "a"


def test_the_persons_picks_win_while_the_catalog_serves_them() -> None:
    catalog = _catalog("big", "small")
    auto = person_models_from_catalog(
        catalog, default_pick=None, light_pick=None, price=PRICES.get
    )
    assert (auto.default, auto.light, auto.automatic_light) == ("big", "small", "small")
    picked = person_models_from_catalog(
        catalog, default_pick="small", light_pick="big", price=PRICES.get
    )
    assert (picked.default, picked.light, picked.automatic_light) == ("small", "big", "small")
    # A pick the connection no longer serves is ignored, not an error.
    gone = person_models_from_catalog(
        catalog, default_pick="gone", light_pick="gone", price=PRICES.get
    )
    assert (gone.default, gone.light) == ("big", "small")


def test_no_usable_catalog_resolves_nothing() -> None:
    nothing = person_models_from_catalog(
        {"status": "unavailable", "models": []}, default_pick="x", light_pick=None
    )
    assert (nothing.default, nothing.light) == (None, None)
