"""Foundation, Builder and Light: how a person's three models resolve from their catalog."""

from __future__ import annotations

from omnigent.superchat.models.tiers import (
    automatic_models,
    cheapest_priced,
    person_models_from_catalog,
)

PRICES = {
    "big": (3e-6, 15e-6),
    "small": (1e-6, 5e-6),
    "small-chatty": (1e-6, 8e-6),
    "mid": (2e-6, 10e-6),
}


def _catalog(*ids: str, default: str | None = None) -> dict:
    return {
        "status": "ready",
        "default_model": default or ids[0],
        "models": [{"id": model} for model in ids],
    }


def test_cheapest_is_the_lowest_input_price_then_output_price() -> None:
    rows = _catalog("big", "small-chatty", "small")["models"]
    assert cheapest_priced(rows, PRICES.get) == "small"
    # Unpriced rows never win over priced ones.
    rows = _catalog("mystery", "big")["models"]
    assert cheapest_priced(rows, PRICES.get) == "big"


def test_a_price_the_connection_reports_beats_the_shared_catalog() -> None:
    rows = [
        {"id": "big", "costPerToken": {"input": 1e-7, "output": 1e-7}},
        {"id": "small"},
    ]
    assert cheapest_priced(rows, PRICES.get) == "big"


def test_no_pricing_falls_back_to_the_catalog_default() -> None:
    rows = _catalog("a", "b", default="b")["models"]
    assert automatic_models(rows, "b", lambda _m: None)["light"] == "b"
    assert automatic_models(rows, None, lambda _m: None)["light"] == "a"


def test_automatic_is_the_catalog_default_and_light_the_cheapest() -> None:
    # No capability signal in the catalog yet: Foundation and Builder are the connection's
    # default, never the dearest model.
    rows = _catalog("small", "big", "mid")["models"]
    assert automatic_models(rows, "mid", PRICES.get) == {
        "foundation": "mid",
        "builder": "mid",
        "light": "small",
    }
    # Nothing priced: the catalog's default for all three.
    assert set(automatic_models(rows, "mid", lambda _m: None).values()) == {"mid"}


def test_the_persons_picks_win_while_the_catalog_serves_them() -> None:
    catalog = _catalog("big", "mid", "small")
    auto = person_models_from_catalog(catalog, {}, price=PRICES.get)
    assert (auto.foundation, auto.builder, auto.light) == ("big", "big", "small")
    assert auto.automatic == {"foundation": "big", "builder": "big", "light": "small"}
    picked = person_models_from_catalog(
        catalog, {"foundation": "mid", "builder": "small", "light": "big"}, price=PRICES.get
    )
    assert (picked.foundation, picked.builder, picked.light) == ("mid", "small", "big")
    assert picked.model("fast") is None  # aliases are the helper dispatch's, not a category
    # A pick the connection no longer serves is ignored, not an error.
    gone = person_models_from_catalog(
        catalog, {"foundation": "gone", "light": "gone"}, price=PRICES.get
    )
    assert (gone.foundation, gone.light) == ("big", "small")


def test_no_usable_catalog_resolves_nothing() -> None:
    nothing = person_models_from_catalog(
        {"status": "unavailable", "models": []}, {"foundation": "x"}
    )
    assert (nothing.foundation, nothing.builder, nothing.light) == (None, None, None)
