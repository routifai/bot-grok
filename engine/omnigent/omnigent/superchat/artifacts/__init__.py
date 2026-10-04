"""Artifacts: deliverable files the Muse saved from its Computer, openable in the app.

Layout: ``store`` (table + blobs, versioned by name per Conversation), ``routes``
(``/v1/artifacts``), ``tools`` (tool defs), ``handlers`` (runner side), ``feature`` (registration).
"""

from __future__ import annotations

from omnigent.superchat.artifacts.feature import ARTIFACTS_FEATURE

FEATURE = ARTIFACTS_FEATURE

__all__ = ["ARTIFACTS_FEATURE", "FEATURE"]
