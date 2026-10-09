"""The chart marker: a chart is a JSON artifact whose file name ends with ``.chart.json``."""

from __future__ import annotations

import re

#: The file-name suffix that marks an artifact as a chart.
CHART_SUFFIX = ".chart.json"


def is_chart_name(name: str) -> bool:
    """True when an artifact file name marks a chart (``*.chart.json``, any case)."""
    return name.lower().endswith(CHART_SUFFIX) and len(name) > len(CHART_SUFFIX)


def chart_stem(name: str) -> str:
    """The chart's name without the ``.chart.json`` suffix."""
    return name[: -len(CHART_SUFFIX)] if is_chart_name(name) else name


def chart_file_name(name: str | None, title: str) -> str:
    """A safe ``<stem>.chart.json`` from an explicit name, else the chart title."""
    raw = chart_stem((name or "").strip()) or title
    stem = re.sub(r"[\s_-]+", "-", re.sub(r"[^\w\- ]+", "", raw, flags=re.UNICODE).strip()).lower()
    return f"{stem[:80].strip('-') or 'chart'}{CHART_SUFFIX}"
