"""The deck marker: a deck is an HTML artifact whose file name ends with ``.deck.html``."""

from __future__ import annotations

#: The file-name suffix that marks an artifact as a deck.
DECK_SUFFIX = ".deck.html"


def is_deck_name(name: str) -> bool:
    """True when an artifact file name marks a deck (``*.deck.html``, any case)."""
    return name.lower().endswith(DECK_SUFFIX) and len(name) > len(DECK_SUFFIX)


def deck_stem(name: str) -> str:
    """The deck's name without the ``.deck.html`` suffix (``q3.deck.html`` -> ``q3``)."""
    return name[: -len(DECK_SUFFIX)] if is_deck_name(name) else name
