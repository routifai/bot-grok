"""Charts: a chart is a saved JSON artifact (``*.chart.json``) the Muse makes from a result file.

Layout: ``spec`` (the ``display_chart`` input as pydantic, ported from nao), ``data`` (reads the
result file in the Computer and checks the spec's columns against it), ``tools`` (the tool def),
``handlers`` (runner side: builds the chart document and saves it as an artifact),
``names`` (the ``.chart.json`` marker), ``feature`` (registration). Sits on top of artifacts.
"""

from __future__ import annotations

from omnigent.superchat.charts.feature import CHARTS_FEATURE
from omnigent.superchat.charts.names import CHART_SUFFIX, chart_stem, is_chart_name

FEATURE = CHARTS_FEATURE

__all__ = ["CHARTS_FEATURE", "CHART_SUFFIX", "FEATURE", "chart_stem", "is_chart_name"]
