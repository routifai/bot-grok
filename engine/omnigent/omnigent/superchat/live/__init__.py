"""Live artifacts: a page that keeps itself up to date from its sources, on a schedule.

Rules are in ``docs/live-artifacts.md``. Layout: ``store`` (the ``artifact_live`` row and its
state), ``logic`` (what an update may change), ``service`` (operations over the stores and the
scheduled task), ``routes`` (``/v1/artifacts/{id}/live`` and the Helper's ``/v1/live-artifacts``),
``tools`` + ``handlers`` (Super Chat and Helper tools), ``feature`` (registration).
Built on ``superchat/artifacts``; that folder knows nothing of this one.
"""

from __future__ import annotations

from omnigent.superchat.live.feature import LIVE_FEATURE

FEATURE = LIVE_FEATURE
