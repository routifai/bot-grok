"""The chart markers: a chart is a JSON artifact named ``*.chart.json``; a dashboard (several
charts and KPI tiles shown as one) is a JSON artifact named ``*.dashboard.json``."""

from __future__ import annotations

import re

#: The file-name suffix that marks an artifact as a chart.
CHART_SUFFIX = ".chart.json"
#: The file-name suffix that marks an artifact as a dashboard.
DASHBOARD_SUFFIX = ".dashboard.json"


def is_chart_name(name: str) -> bool:
    """True when an artifact file name marks a chart (``*.chart.json``, any case)."""
    return name.lower().endswith(CHART_SUFFIX) and len(name) > len(CHART_SUFFIX)


def is_dashboard_name(name: str) -> bool:
    """True when an artifact file name marks a dashboard (``*.dashboard.json``, any case)."""
    return name.lower().endswith(DASHBOARD_SUFFIX) and len(name) > len(DASHBOARD_SUFFIX)


def chart_stem(name: str) -> str:
    """The chart's name without the ``.chart.json`` suffix."""
    return name[: -len(CHART_SUFFIX)] if is_chart_name(name) else name


def _file_name(name: str | None, title: str, suffix: str, fallback: str) -> str:
    raw = (name or "").strip()
    if raw.lower().endswith(suffix):
        raw = raw[: -len(suffix)]
    raw = raw or title
    stem = re.sub(r"[\s_-]+", "-", re.sub(r"[^\w\- ]+", "", raw, flags=re.UNICODE).strip()).lower()
    return f"{stem[:80].strip('-') or fallback}{suffix}"


def chart_file_name(name: str | None, title: str) -> str:
    """A safe ``<stem>.chart.json`` from an explicit name, else the chart title."""
    return _file_name(name, title, CHART_SUFFIX, "chart")


def dashboard_file_name(name: str | None, title: str) -> str:
    """A safe ``<stem>.dashboard.json`` from an explicit name, else the dashboard title."""
    return _file_name(name, title, DASHBOARD_SUFFIX, "dashboard")
