"""Sheets: CSV / XLSX artifacts read as grids, hand-edited into new versions, written back.

Layout: ``table`` (read / apply edits), ``xlsx_patch`` (edit an XLSX in place), ``routes``
(``/v1/artifacts/{id}/table``), ``writeback`` (hand edits -> the Computer workspace, run as a
turn prefix), ``feature`` (registration). Sits on top of artifacts.
"""

from __future__ import annotations

from omnigent.superchat.sheets.feature import SHEETS_FEATURE

FEATURE = SHEETS_FEATURE

__all__ = ["FEATURE", "SHEETS_FEATURE"]
