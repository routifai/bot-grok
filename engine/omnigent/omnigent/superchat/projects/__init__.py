"""Projects: folders under ``~/workspace/projects/<slug>/`` the Muse opens on its own.

A Project is a folder with a ``PROJECT.md`` card (see ``card``). Each turn the runner lists the
cards (``block``); the Muse picks one and calls ``open_project`` (``handlers``), which moves the
session's working directory through the generic ``PUT /v1/sessions/{id}/workspace`` route.
Layout: ``card`` (read cards), ``block`` (the per-turn list), ``tools`` (tool def), ``handlers``
(runner side), ``feature`` (registration). Nothing scans or indexes in the background.
"""

from __future__ import annotations

from omnigent.superchat.projects.feature import PROJECTS_FEATURE

FEATURE = PROJECTS_FEATURE

__all__ = ["FEATURE", "PROJECTS_FEATURE"]
