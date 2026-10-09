"""Decks: a saved HTML deck (``*.deck.html``) exported to editable PowerPoint or vector PDF.

Layout: ``tools`` (the ``deck_export`` tool def), ``handlers`` (runner side: runs the Computer's
``nova-deck-export`` helper and saves the result), ``routes`` (``/v1/decks/{id}/export`` for the
panel's Export buttons), ``feature`` (registration). Sits on top of artifacts.
"""

from __future__ import annotations

from omnigent.superchat.decks.feature import DECKS_FEATURE
from omnigent.superchat.decks.names import DECK_SUFFIX, deck_stem, is_deck_name

FEATURE = DECKS_FEATURE

__all__ = ["DECKS_FEATURE", "DECK_SUFFIX", "FEATURE", "deck_stem", "is_deck_name"]
