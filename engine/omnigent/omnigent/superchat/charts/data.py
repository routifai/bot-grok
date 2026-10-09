"""Read a chart's rows from a result file in the Computer (the replacement for nao's query_id).

The model's own code (pandas, duckdb) writes the result; the chart reads it here, runner side,
so the model never retypes values. CSV, JSON and JSON Lines read with the standard library;
Parquet needs ``duckdb`` or ``pyarrow`` in the runner's Python and says so when neither is there.
"""

from __future__ import annotations

import csv
import datetime as dt
import decimal
import json
import math
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from omnigent.superchat.charts.spec import DEFAULT_MAX_ROWS, ChartSpec

#: Largest result file the chart will read (bytes); aggregate in code first.
MAX_SOURCE_BYTES = 50 * 1024 * 1024
SOURCE_SUFFIXES = (".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet")

Row = dict[str, Any]


class ChartDataError(ValueError):
    """A sentence for the model: what is wrong with the result file or the spec's columns."""


def _json_safe(value: Any) -> Any:
    """A JSON-serialisable cell: dates to ISO strings, NaN/inf/missing to ``None``."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (int,)):
        return value
    if isinstance(value, decimal.Decimal):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalar
        return _json_safe(value.item())
    return str(value)


def _read_csv(path: Path, delimiter: str, limit: int) -> tuple[list[str], list[Row]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=delimiter)
        columns = [c for c in (reader.fieldnames or []) if c is not None]
        rows: list[Row] = []
        for raw in reader:
            rows.append({c: (raw.get(c) if raw.get(c) != "" else None) for c in columns})
            if len(rows) >= limit + 1:
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
        if len(rows) >= limit + 1:
            break
    return columns, rows


def _read_json(path: Path, limit: int) -> tuple[list[str], list[Row]]:
    text = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(text)
    except ValueError:
        # JSON Lines: one object per line.
        lines = (line for line in text.splitlines() if line.strip())
        try:
            return _records((json.loads(line) for line in lines), limit)
        except ValueError as exc:
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


def _read_jsonl(path: Path, limit: int) -> tuple[list[str], list[Row]]:
    def lines() -> Iterable[Any]:
        with path.open(encoding="utf-8-sig") as handle:
            for line in handle:
                if line.strip():
                    yield json.loads(line)

    try:
        return _records(lines(), limit)
    except ValueError as exc:
        if isinstance(exc, ChartDataError):
            raise
        raise ChartDataError(f"Could not parse the JSON Lines file: {exc}") from exc


def _read_parquet(path: Path, limit: int) -> tuple[list[str], list[Row]]:
    try:
        import duckdb  # type: ignore[import-not-found]
    except ImportError:
        duckdb = None
    if duckdb is not None:
        con = duckdb.connect()
        try:
            cur = con.execute("SELECT * FROM read_parquet(?) LIMIT ?", [str(path), limit + 1])
            columns = [d[0] for d in cur.description]
            return columns, [dict(zip(columns, r, strict=False)) for r in cur.fetchall()]
        finally:
            con.close()
    try:
        import pyarrow.parquet as pq  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ChartDataError(
            "This Computer cannot read Parquet (no duckdb or pyarrow). Write the result as CSV "
            "or JSON with your code and chart that file."
        ) from exc
    table = pq.read_table(path)
    columns = list(table.column_names)
    return columns, table.slice(0, limit + 1).to_pylist()


def read_rows(path: Path, max_rows: int | None) -> tuple[list[str], list[Row], bool]:
    """
    Read up to ``max_rows`` rows of a result file.

    :param path: A file already resolved inside the workspace.
    :param max_rows: Row cap (default 2000).
    :returns: ``(columns, rows, truncated)`` with JSON-safe cells.
    :raises ChartDataError: The file is unreadable, empty or too big.
    """
    limit = max_rows or DEFAULT_MAX_ROWS
    suffix = path.suffix.lower()
    if suffix not in SOURCE_SUFFIXES:
        raise ChartDataError(
            f"Unsupported result file type '{suffix or path.name}'; "
            "use .csv, .json, .jsonl or .parquet"
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
        if suffix == ".csv":
            columns, rows = _read_csv(path, ",", limit)
        elif suffix == ".tsv":
            columns, rows = _read_csv(path, "\t", limit)
        elif suffix == ".json":
            columns, rows = _read_json(path, limit)
        elif suffix in (".jsonl", ".ndjson"):
            columns, rows = _read_jsonl(path, limit)
        else:
            columns, rows = _read_parquet(path, limit)
    except ChartDataError:
        raise
    except (OSError, UnicodeDecodeError, csv.Error) as exc:
        raise ChartDataError(f"Could not read the result file: {exc}") from exc
    if not rows:
        raise ChartDataError("The result file has no rows")
    truncated = len(rows) > limit
    rows = rows[:limit]
    return columns, [{k: _json_safe(v) for k, v in row.items()} for row in rows], truncated


def _match_column(columns: list[str], name: str) -> str | None:
    if name in columns:
        return name
    lower = name.lower()
    return next((c for c in columns if c.lower() == lower), None)


def _to_number(value: Any) -> float | int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
        if not math.isfinite(number):
            return None
        return (
            int(number)
            if number.is_integer() and "." not in text and "e" not in text.lower()
            else number
        )
    return None


def shape_rows(
    spec: ChartSpec, columns: list[str], rows: list[Row], keep: list[str] | None
) -> tuple[ChartSpec, list[str], list[Row]]:
    """
    Check the spec's columns against the file and return the spec (names resolved to the real
    columns), the kept columns and the rows (series columns as numbers).

    :raises ChartDataError: A named column is not in the file, or a series column is not numeric.
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

    series_keys = {s.data_key for s in series}
    shaped: list[Row] = []
    for row in rows:
        out: Row = {}
        for column in kept:
            value = row.get(column)
            out[column] = _to_number(value) if column in series_keys else value
        shaped.append(out)
    for key in series_keys:
        if all(r[key] is None for r in shaped):
            raise ChartDataError(
                f"Column '{key}' has no numbers in the first {len(rows)} rows; "
                "series columns must be numeric"
            )
    if resolved.x_axis_type == "number" and x_key:
        for r in shaped:
            r[x_key] = _to_number(r[x_key])
    return resolved, kept, shaped
