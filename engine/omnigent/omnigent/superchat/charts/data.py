"""Read a chart's rows from a result file in the Computer (the replacement for nao's query_id).

The model's own code (pandas, duckdb) writes the result; the chart reads it here, runner side,
so the model never retypes values. CSV, TSV, JSON and JSON Lines read with the standard library.
Nothing is guessed: a series cell that is not a plain number, a date that is not ISO, a ragged
CSV row or an integer a browser cannot hold exactly is refused with a sentence naming it, so the
model fixes the file in code instead of the chart quietly drawing wrong numbers.
"""

from __future__ import annotations

import csv
import datetime as dt
import decimal
import json
import math
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from omnigent.superchat.charts.spec import DEFAULT_MAX_ROWS, ChartSpec

#: Largest result file the chart will read (bytes); aggregate in code first.
MAX_SOURCE_BYTES = 50 * 1024 * 1024
#: Rows read from a file before the chart's own cap applies (a date chart keeps the newest rows).
READ_CAP = 200_000
SOURCE_SUFFIXES = (".csv", ".tsv", ".json", ".jsonl", ".ndjson")
#: Integers beyond this are no longer exact in a browser (JSON numbers are doubles there).
MAX_EXACT_INT = 2**53

Row = dict[str, Any]

_PLAIN_NUMBER = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
_GROUPED_NUMBER = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")
_ISO_DATE = re.compile(
    r"^\d{4}-\d{2}(-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?$"
)
_MIDNIGHT = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T]00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$")


class ChartDataError(ValueError):
    """A sentence for the model: what is wrong with the result file or the spec's columns."""


def _json_safe(value: Any) -> Any:
    """A JSON-serialisable cell: dates to ISO strings, NaN/inf/missing to ``None``."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, int):
        return value if abs(value) <= MAX_EXACT_INT else str(value)
    if isinstance(value, decimal.Decimal):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, dt.datetime):
        return value.date().isoformat() if value.time() == dt.time(0) else value.isoformat()
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalar
        return _json_safe(value.item())
    return str(value)


def _read_csv(path: Path, delimiter: str, limit: int) -> tuple[list[str], list[Row]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        header = next(reader, None)
        if not header:
            raise ChartDataError("The result file has no header row")
        columns = [c.strip() for c in header]
        duplicated = sorted({c for c in columns if columns.count(c) > 1})
        if duplicated:
            raise ChartDataError(
                f"The result file has duplicate column names ({', '.join(duplicated)}); "
                "rename them in your code"
            )
        rows: list[Row] = []
        for raw in reader:
            if not raw:
                continue
            if len(raw) != len(columns):
                raise ChartDataError(
                    f"Row {len(rows) + 1} of the result file has {len(raw)} fields but the header "
                    f"has {len(columns)}; quote values that contain the delimiter"
                )
            rows.append({c: (v if v != "" else None) for c, v in zip(columns, raw, strict=True)})
            if len(rows) > limit:
                break
    return columns, rows


def _records(items: Iterable[Any], limit: int) -> tuple[list[str], list[Row]]:
    rows: list[Row] = []
    columns: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            raise ChartDataError("The JSON file must hold a list of row objects")
        for key in item:
            if key not in columns:
                columns.append(key)
        rows.append(dict(item))
        if len(rows) > limit:
            break
    return columns, rows


def _read_json(path: Path, limit: int) -> tuple[list[str], list[Row]]:
    text = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(text)
    except ValueError:
        lines = (line for line in text.splitlines() if line.strip())
        try:
            return _records((json.loads(line) for line in lines), limit)
        except ValueError as exc:
            if isinstance(exc, ChartDataError):
                raise
            raise ChartDataError(f"Could not parse the JSON file: {exc}") from exc
    if isinstance(data, dict):
        for key in ("data", "rows", "records", "results"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            # Column-oriented ``{"col": [..], ...}``.
            if data and all(isinstance(v, list) for v in data.values()):
                length = max(len(v) for v in data.values())
                data = [
                    {k: (v[i] if i < len(v) else None) for k, v in data.items()}
                    for i in range(length)
                ]
    if not isinstance(data, list):
        raise ChartDataError("The JSON file must hold a list of row objects")
    return _records(data, limit)


def read_rows(path: Path) -> tuple[list[str], list[Row], bool]:
    """
    Read a result file (up to :data:`READ_CAP` rows).

    :param path: A file already resolved inside the workspace.
    :returns: ``(columns, rows, cut)``; ``cut`` is true when the file held more rows than read.
    :raises ChartDataError: The file is unreadable, empty or too big.
    """
    suffix = path.suffix.lower()
    if suffix not in SOURCE_SUFFIXES:
        raise ChartDataError(
            f"Unsupported result file type '{suffix or path.name}'; use .csv, .json or .jsonl"
        )
    size = path.stat().st_size
    if size == 0:
        raise ChartDataError("The result file is empty")
    if size > MAX_SOURCE_BYTES:
        raise ChartDataError(
            f"The result file is {size // (1024 * 1024)} MB; "
            "aggregate it in code first (50 MB max)"
        )
    try:
        if suffix in (".csv", ".tsv"):
            columns, rows = _read_csv(path, "," if suffix == ".csv" else "\t", READ_CAP)
        else:
            columns, rows = _read_json(path, READ_CAP)
    except ChartDataError:
        raise
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ChartDataError(f"Could not read the result file: {exc}") from exc
    if not rows:
        raise ChartDataError("The result file has no rows")
    cut = len(rows) > READ_CAP
    return columns, rows[:READ_CAP], cut


def _match_column(columns: list[str], name: str) -> str | None:
    if name in columns:
        return name
    lower = name.lower()
    return next((c for c in columns if c.lower() == lower), None)


def _number(value: Any) -> tuple[float | int | None, str | None]:
    """``(number, None)``, ``(None, None)`` for an empty cell, or ``(None, why)``."""
    value = _json_safe(value)
    if value is None:
        return None, None
    if isinstance(value, bool):
        return None, "a boolean"
    if isinstance(value, (int, float)):
        return value, None
    text = str(value).strip()
    if not text:
        return None, None
    if _GROUPED_NUMBER.match(text):
        text = text.replace(",", "")
    if not _PLAIN_NUMBER.match(text):
        return None, "not a plain number"
    if re.fullmatch(r"[+-]?\d+", text):
        number = int(text)
        if abs(number) > MAX_EXACT_INT:
            return None, "larger than 2^53 (not exact in a browser; cast to float or scale it)"
        return number, None
    number = float(text)
    if not math.isfinite(number):
        return None, "not finite"
    return number, None


def _date_text(value: Any) -> str | None:
    """The cell as ``YYYY-MM-DD`` (midnight) or ISO date-time text, or ``None`` if not ISO."""
    value = _json_safe(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not _ISO_DATE.match(text):
        return None
    midnight = _MIDNIGHT.match(text)
    return midnight.group(1) if midnight else text


def _instant(text: str) -> float:
    """Seconds since the epoch for an ISO date or date-time (no offset means UTC)."""
    padded = text + "-01" if re.fullmatch(r"\d{4}-\d{2}", text) else text
    parsed = dt.datetime.fromisoformat(padded.replace(" ", "T").replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.timestamp()


def _bad_cells(found: list[tuple[int, Any, str]], column: str, role: str) -> ChartDataError:
    shown = "; ".join(f"row {i}: {str(v)[:30]!r} ({why})" for i, v, why in found[:5])
    more = f" (and {len(found) - 5} more)" if len(found) > 5 else ""
    return ChartDataError(
        f"{role} '{column}' has values the chart cannot read: {shown}{more}. "
        "Clean the file in code (plain numbers, ISO dates) and chart it again."
    )


def shape_rows(
    spec: ChartSpec,
    columns: list[str],
    rows: list[Row],
    keep: list[str] | None,
    max_rows: int | None,
    *,
    cut: bool = False,
) -> tuple[ChartSpec, list[str], list[Row], bool]:
    """
    Check the spec's columns against the file and return what the chart stores.

    :returns: ``(spec with the real column names, kept columns, rows, truncated)``. Series
        columns are numbers; a date chart keeps its newest rows past the cap.
    :raises ChartDataError: A named column is missing, or a cell cannot be read as asked.
    """

    def need(name: str, role: str) -> str:
        match = _match_column(columns, name)
        if match is None:
            shown = ", ".join(columns[:30])
            raise ChartDataError(
                f"{role} '{name}' is not a column of the result file. Columns: {shown}"
            )
        return match

    x_key = need(spec.x_axis_key, "x_axis_key") if spec.x_axis_key else None
    series = [
        s.model_copy(update={"data_key": need(s.data_key, "series data_key")}) for s in spec.series
    ]
    resolved = spec.model_copy(update={"x_axis_key": x_key, "series": series})
    wanted = [x_key, *(s.data_key for s in series)]
    if keep is not None:
        wanted += [need(c, "source.columns entry") for c in keep]
    kept = list(dict.fromkeys(c for c in wanted if c))
    series_keys = list(dict.fromkeys(s.data_key for s in series))

    indexed = list(enumerate(rows, start=1))
    limit = max_rows or DEFAULT_MAX_ROWS
    if spec.x_axis_type == "date" and x_key:
        bad: list[tuple[int, Any, str]] = []
        dated: list[tuple[float, int, str, Row]] = []
        for index, row in indexed:
            text = _date_text(row.get(x_key))
            if text is None:
                bad.append((index, row.get(x_key), "not an ISO date like 2026-01-31"))
                continue
            try:
                instant = _instant(text)
            except ValueError:
                bad.append((index, row.get(x_key), "not a real date"))
                continue
            dated.append((instant, index, text, row))
        if bad:
            raise _bad_cells(bad, x_key, "x_axis_key (x_axis_type date)")
        # Sort by the instant, not the text: "…T10:00+02:00" is earlier than "…T09:00Z".
        dated.sort(key=lambda item: (item[0], item[1]))  # the newest rows come last
        indexed = [(index, {**row, x_key: text}) for _, index, text, row in dated]
        selected = indexed[-limit:]
    else:
        selected = indexed[:limit]
    truncated = cut or len(indexed) > limit

    shaped: list[Row] = []
    problems: dict[str, list[tuple[int, Any, str]]] = {}
    for index, row in selected:
        out: Row = {}
        for column in kept:
            value = row.get(column)
            if column in series_keys or (column == x_key and spec.x_axis_type == "number"):
                number, why = _number(value)
                if why:
                    problems.setdefault(column, []).append((index, value, why))
                out[column] = number
            else:
                out[column] = _json_safe(value)
        shaped.append(out)
    for column, found in problems.items():
        role = "series column" if column in series_keys else "x_axis_key"
        raise _bad_cells(found, column, role)
    for key in series_keys:
        if all(r[key] is None for r in shaped):
            raise ChartDataError(f"Column '{key}' has no numbers; series columns must be numeric")
    return resolved, kept, shaped, truncated
