"""Charts: the ``display_chart`` spec, the result-file reader and the saving handler."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.superchat.artifacts.routes import create_artifacts_router
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
from omnigent.superchat.charts import CHART_SUFFIX, chart_stem, is_chart_name
from omnigent.superchat.charts.data import (
    READ_CAP,
    ChartDataError,
    _date_text,
    _instant,
    _json_safe,
    read_rows,
    shape_rows,
)
from omnigent.superchat.charts.feature import CHARTS_FEATURE
from omnigent.superchat.charts.handlers import handle_chart_tool
from omnigent.superchat.charts.names import chart_file_name
from omnigent.superchat.charts.spec import (
    CHART_COLOR_PATTERN,
    CHART_TYPES,
    ChartSpec,
    DisplayChartInput,
    display_chart_parameters,
)
from omnigent.superchat.charts.tools import DisplayChartTool
from omnigent.superchat.feature import HandlerCtx

_CHAT = uuid.uuid4().hex
H = {"x-user": "alice"}

CSV = "month,revenue,margin\n2026-01,100,0.2\n2026-02,120,0.25\n2026-03,,0.3\n2026-04,150,0.31\n"


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("x-user")


def _call(path: str, **extra: Any) -> dict[str, Any]:
    return {
        "chart_type": "bar",
        "title": "Revenue by month",
        "x_axis_key": "month",
        "x_axis_type": "category",
        "series": [{"data_key": "revenue"}],
        "source": {"path": path},
        **extra,
    }


def test_names() -> None:
    assert CHART_SUFFIX == ".chart.json"
    assert is_chart_name("a.chart.json") and is_chart_name("A.CHART.JSON")
    assert not is_chart_name("a.json") and not is_chart_name(".chart.json")
    assert chart_stem("a.chart.json") == "a"
    assert chart_file_name(None, "Revenue by Month / Q3!") == "revenue-by-month-q3.chart.json"
    assert chart_file_name("my chart.chart.json", "x") == "my-chart.chart.json"
    assert chart_file_name("???", "") == "chart.chart.json"


def test_tool_schema_is_the_spec() -> None:
    schema = DisplayChartTool().get_schema()["function"]
    assert schema["name"] == "display_chart"
    params = schema["parameters"]
    assert "$defs" not in json.dumps(params) and "$ref" not in json.dumps(params)
    assert set(params["required"]) == {"chart_type", "title", "series", "source"}
    assert params["properties"]["chart_type"]["enum"] == list(CHART_TYPES)
    # a field named ``title`` survives the schema clean-up, nested models are inlined
    assert params["properties"]["title"]["type"] == "string"
    assert params["properties"]["source"]["properties"]["path"]["type"] == "string"
    series = params["properties"]["series"]
    assert series["minItems"] == 1
    assert "prefix" in series["items"]["properties"]["value_format"]["properties"]
    assert "never retype" in params["properties"]["source"]["properties"]["path"]["description"]
    assert CHARTS_FEATURE.tools({}, None) == []  # type: ignore[arg-type]
    assert "display_chart" in CHARTS_FEATURE.handlers


@pytest.mark.parametrize(
    "patch",
    [
        {"x_axis_key": None},
        {"chart_type": "table"},
        {"series": []},
        {"y_axis_min": 5, "y_axis_max": 1},
        {"chart_type": "pie", "series": [{"data_key": "a"}, {"data_key": "b"}]},
        {"surprise": 1},
    ],
)
def test_spec_rejects(patch: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        DisplayChartInput.model_validate({**_call("r.csv"), **patch})


def test_kpi_card_needs_no_x_axis() -> None:
    spec = ChartSpec.model_validate(
        {"chart_type": "kpi_card", "title": "Revenue", "series": [{"data_key": "revenue"}],
         "comparison_mode": "percentage"}
    )  # fmt: skip
    assert spec.x_axis_key is None


def _spec(**patch: Any) -> ChartSpec:
    base = {k: v for k, v in _call("r.csv").items() if k != "source"}
    return ChartSpec.model_validate({**base, **patch})


def _shape(spec: ChartSpec, path: Path, max_rows: int | None = None):
    columns, rows, cut = read_rows(path)
    return shape_rows(spec, columns, rows, None, max_rows, cut=cut)


def _csv(tmp_path: Path, text: str, name: str = "r.csv") -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


def test_read_csv_and_shape(tmp_path: Path) -> None:
    path = _csv(tmp_path, CSV)
    columns, rows, cut = read_rows(path)
    assert columns == ["month", "revenue", "margin"] and len(rows) == 4 and not cut
    resolved, kept, shaped, truncated = _shape(_spec(x_axis_key="MONTH"), path)
    assert resolved.x_axis_key == "month" and kept == ["month", "revenue"] and not truncated
    assert shaped[0] == {"month": "2026-01", "revenue": 100}
    assert shaped[2]["revenue"] is None  # an empty cell stays a gap


def test_row_cap_and_truncation(tmp_path: Path) -> None:
    path = _csv(tmp_path, "x,y\n" + "\n".join(f"{i},{i}" for i in range(50)))
    _, _, shaped, truncated = _shape(_spec(x_axis_key="x", series=[{"data_key": "y"}]), path, 10)
    assert (
        len(shaped) == 10 and truncated and shaped[0]["y"] == 0
    )  # a category chart keeps the head


def test_a_date_chart_keeps_the_newest_rows(tmp_path: Path) -> None:
    lines = [f"2026-01-{d:02d},{d}" for d in range(31, 0, -1)]  # newest first in the file
    path = _csv(tmp_path, "day,v\n" + "\n".join(lines))
    spec = _spec(x_axis_key="day", x_axis_type="date", series=[{"data_key": "v"}])
    _, _, shaped, truncated = _shape(spec, path, 5)
    assert truncated and [r["day"] for r in shaped] == [f"2026-01-{d}" for d in range(27, 32)]


def test_dates_must_be_iso_and_midnight_is_a_plain_date(tmp_path: Path) -> None:
    spec = _spec(x_axis_key="day", x_axis_type="date", series=[{"data_key": "v"}])
    ok = _csv(
        tmp_path, "day,v\n2026-01-01 00:00:00,1\n2026-01-02T00:00:00,2\n2026-01-03 10:30,3\n"
    )
    _, _, shaped, _ = _shape(spec, ok)
    assert [r["day"] for r in shaped] == ["2026-01-01", "2026-01-02", "2026-01-03 10:30"]
    bad = _csv(tmp_path, "day,v\n01/02/2026,1\n2026-01-02,2\n", "bad.csv")
    with pytest.raises(ChartDataError, match=r"row 1: '01/02/2026'.*ISO"):
        _shape(spec, bad)


def test_datetime_values_from_json_midnight_are_dates(tmp_path: Path) -> None:
    import datetime as dt

    assert _json_safe(dt.datetime(2026, 1, 1, tzinfo=dt.UTC)) == "2026-01-01"
    assert _json_safe(dt.datetime(2026, 1, 1, 9, 30, tzinfo=dt.UTC)) == "2026-01-01T09:30:00+00:00"


def test_unknown_column_lists_the_real_ones(tmp_path: Path) -> None:
    path = _csv(tmp_path, CSV)
    with pytest.raises(ChartDataError, match=r"'revenu'.*Columns: month, revenue, margin"):
        _shape(_spec(series=[{"data_key": "revenu"}]), path)


def test_non_numeric_series_is_refused(tmp_path: Path) -> None:
    path = _csv(tmp_path, CSV)
    with pytest.raises(ChartDataError, match="not a plain number"):
        _shape(_spec(series=[{"data_key": "month"}]), path)


@pytest.mark.parametrize(
    ("cell", "expected"),
    [("1,234", 1234), ("1,234,567.5", 1234567.5), ("-12", -12), ("3.5e2", 350.0), ("0.25", 0.25)],
)
def test_numbers_parse_exactly(tmp_path: Path, cell: str, expected: float) -> None:
    path = _csv(tmp_path, f'm,v\na,"{cell}"\n')
    _, _, shaped, _ = _shape(_spec(x_axis_key="m", series=[{"data_key": "v"}]), path)
    assert shaped[0]["v"] == expected


@pytest.mark.parametrize("cell", ["1,5", "12%", "$10", "n/a", "NaN", "inf", "1 000", "1,23,456"])
def test_ambiguous_or_unparseable_numbers_are_refused_by_name(tmp_path: Path, cell: str) -> None:
    path = _csv(tmp_path, f'm,v\na,1\nb,"{cell}"\n')
    with pytest.raises(ChartDataError, match=r"row 2: .*not a plain number"):
        _shape(_spec(x_axis_key="m", series=[{"data_key": "v"}]), path)


def test_integers_beyond_2_53_are_refused(tmp_path: Path) -> None:
    path = _csv(tmp_path, "m,v\na,9007199254740993\n")
    with pytest.raises(ChartDataError, match="2\\^53"):
        _shape(_spec(x_axis_key="m", series=[{"data_key": "v"}]), path)
    (tmp_path / "big.json").write_text(json.dumps([{"m": "a", "v": 2**60}]))
    with pytest.raises(ChartDataError, match="2\\^53"):
        _shape(_spec(x_axis_key="m", series=[{"data_key": "v"}]), tmp_path / "big.json")


def test_csv_quirks_are_refused(tmp_path: Path) -> None:
    with pytest.raises(ChartDataError, match="duplicate column names \\(a\\)"):
        read_rows(_csv(tmp_path, "a,a,b\n1,2,3\n", "dup.csv"))
    with pytest.raises(ChartDataError, match=r"Row 2 .* has 4 fields but the header has 3"):
        read_rows(_csv(tmp_path, "a,b,c\n1,2,3\n1,2,3,4\n", "wide.csv"))
    with pytest.raises(ChartDataError, match=r"Row 1 .* has 2 fields"):
        read_rows(_csv(tmp_path, "a,b,c\n1,2\n", "short.csv"))


def test_a_huge_file_is_cut_at_the_read_cap(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("omnigent.superchat.charts.data.READ_CAP", 20)
    path = _csv(tmp_path, "x,y\n" + "\n".join(f"{i},{i}" for i in range(50)))
    _, rows, cut = read_rows(path)
    assert len(rows) == 20 and cut
    assert READ_CAP == 200_000


def test_json_shapes(tmp_path: Path) -> None:
    rows = [{"a": 1, "b": 2}, {"a": 3, "b": float("nan")}]
    (tmp_path / "list.json").write_text(json.dumps(rows))
    (tmp_path / "wrapped.json").write_text(json.dumps({"rows": rows}))
    (tmp_path / "cols.json").write_text(json.dumps({"a": [1, 3], "b": [2, None]}))
    (tmp_path / "lines.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    for name in ("list.json", "wrapped.json", "cols.json", "lines.jsonl"):
        columns, got, _ = read_rows(tmp_path / name)
        assert columns == ["a", "b"] and len(got) == 2, name
        assert _json_safe(got[1]["b"]) is None, name  # NaN never reaches the JSON document


def test_unreadable_files(tmp_path: Path) -> None:
    (tmp_path / "e.csv").write_text("")
    (tmp_path / "h.csv").write_text("a,b\n")
    (tmp_path / "x.xlsx").write_bytes(b"PK")
    (tmp_path / "bad.json").write_text("[1, 2]")
    for name, text in (
        ("e.csv", "empty"),
        ("h.csv", "no rows"),
        ("x.xlsx", "Unsupported"),
        ("bad.json", "list of row objects"),
    ):
        with pytest.raises(ChartDataError, match=text):
            read_rows(tmp_path / name)


@pytest.fixture()
def store(db_uri: str, tmp_path: Path) -> SqlAlchemyArtifactStore:
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    return SqlAlchemyArtifactStore(db_uri, lambda: blobs)


@pytest.fixture()
def server(store: SqlAlchemyArtifactStore):
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.http_status)

    class _Convs:
        pass

    app.include_router(
        create_artifacts_router(store, conversation_store=_Convs(), auth_provider=_Auth()),  # type: ignore[arg-type]
        prefix="/v1",
    )

    @app.get("/v1/sessions/{sid}")
    async def session(sid: str) -> dict[str, Any]:
        return {"kind": "chat", "parent_session_id": None}

    return app


def _ctx(server: FastAPI) -> HandlerCtx:
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server), base_url="http://t", headers=H
    )
    return HandlerCtx("display_chart", client, _CHAT, {})


@pytest.mark.asyncio
async def test_handler_saves_a_chart_artifact_and_versions(
    server, store, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path))
    (tmp_path / "r.csv").write_text(CSV)
    out = json.loads(await handle_chart_tool(_ctx(server), _call("r.csv")))
    assert out["type"] == "artifact" and out["name"] == "revenue-by-month.chart.json"
    assert out["title"] == "Revenue by month" and out["version"] == 1
    assert out["chart"] == {
        "chart_type": "bar", "rows": 4, "columns": ["month", "revenue"],
        "truncated": False, "source": "r.csv",
    }  # fmt: skip
    # the stored bytes are the document: the spec without its source, plus a data snapshot
    saved = store.get(out["id"], user_id="alice")
    assert saved is not None
    doc = json.loads(store.read(saved))
    assert doc["version"] == 1 and doc["spec"]["chart_type"] == "bar"
    assert "source" not in doc["spec"] and doc["source"]["file"] == "r.csv"
    assert doc["source"]["path"] == "r.csv"  # relative to the workspace, never the Computer's path
    assert doc["data"][0] == {"month": "2026-01", "revenue": 100}
    (tmp_path / "r.csv").write_text(CSV + "2026-05,160,0.3\n")
    again = json.loads(await handle_chart_tool(_ctx(server), _call("r.csv")))
    assert again["name"] == out["name"] and again["version"] == 2


@pytest.mark.asyncio
async def test_handler_errors_are_sentences(server, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path))
    (tmp_path / "r.csv").write_text(CSV)
    ctx = _ctx(server)
    missing = json.loads(await handle_chart_tool(ctx, _call("nope.csv")))
    assert "file not found" in missing["error"]
    bad_column = json.loads(
        await handle_chart_tool(ctx, _call("r.csv", series=[{"data_key": "sales"}]))
    )
    assert "'sales' is not a column" in bad_column["error"]
    invalid = json.loads(await handle_chart_tool(ctx, {"chart_type": "bar"}))
    assert invalid["error"].startswith("Invalid chart:")
    outside = tmp_path.parent / "outside.csv"
    outside.write_text(CSV)
    escaped = json.loads(await handle_chart_tool(ctx, _call(str(outside))))
    assert "inside your workspace" in escaped["error"]


@pytest.mark.asyncio
async def test_source_path_is_stored_relative_to_the_workspace(
    server, store, tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path))
    (tmp_path / "out").mkdir()
    (tmp_path / "out" / "r.csv").write_text(CSV)
    out = json.loads(await handle_chart_tool(_ctx(server), _call(str(tmp_path / "out" / "r.csv"))))
    saved = store.get(out["id"], user_id="alice")
    assert saved is not None
    assert json.loads(store.read(saved))["source"]["path"] == "out/r.csv"


@pytest.mark.parametrize(
    "color",
    [
        "#1d1d1f",
        "#abc",
        "rgb(0, 113, 227)",
        "rgba(0,0,0,0.5)",
        "hsl(210 50% 40%)",
        "tomato",
        "var(--chart-3)",
    ],
)
def test_series_colors_that_are_safe(color: str) -> None:
    DisplayChartInput.model_validate(
        _call("r.csv", series=[{"data_key": "revenue", "color": color}])
    )


@pytest.mark.parametrize(
    "color",
    [
        'red" onload="x',
        "red;}</style>",
        "url(http://x)",
        "var(--background)",
        "#12345g",
        "a" * 80,
        "<x>",
    ],
)
def test_series_colors_that_could_break_out_are_rejected(color: str) -> None:
    with pytest.raises(ValueError):
        DisplayChartInput.model_validate(
            _call("r.csv", series=[{"data_key": "revenue", "color": color}])
        )


def _surface(schema_fragment: dict[str, Any]) -> dict[str, Any]:
    return {
        "properties": sorted(schema_fragment["properties"]),
        "required": sorted(schema_fragment.get("required", [])),
    }


def spec_surface() -> dict[str, Any]:
    """What both implementations of the spec must agree on (the zod twin reads the same file)."""
    params = display_chart_parameters()
    props = params["properties"]
    chart = {k: v for k, v in props.items() if k not in ("source", "name")}
    series = props["series"]["items"]
    return {
        "chart_types": props["chart_type"]["enum"],
        "chart": {
            "properties": sorted(chart),
            "required": sorted(r for r in params["required"] if r != "source"),
        },
        "series": _surface(series),
        "value_format": _surface(series["properties"]["value_format"]),
        "source": _surface(props["source"]),
        "enums": {
            "x_axis_type": props["x_axis_type"]["enum"],
            "series_type": series["properties"]["series_type"]["enum"],
            "y_axis": series["properties"]["y_axis"]["enum"],
            "comparison_mode": props["comparison_mode"]["enum"],
            "compact": series["properties"]["value_format"]["properties"]["compact"]["enum"],
        },
        "color_pattern": CHART_COLOR_PATTERN,
    }


def test_the_spec_matches_the_web_twin() -> None:
    """The zod side reads the same ``packages/charts/spec-parity.json`` (spec.parity.test.ts)."""
    path = Path(__file__).resolve().parents[5] / "packages" / "charts" / "spec-parity.json"
    assert json.loads(path.read_text()) == spec_surface(), (
        "the pydantic and zod chart specs drifted: update both, then regenerate spec-parity.json"
    )


def test_dates_sort_by_instant_not_by_text(tmp_path: Path) -> None:
    spec = _spec(x_axis_key="t", x_axis_type="date", series=[{"data_key": "v"}])
    # 10:00+02:00 (08:00Z) is earlier than 09:00Z although it sorts later as text.
    path = _csv(tmp_path, "t,v\n2026-01-01T09:00:00Z,1\n2026-01-01T10:00:00+02:00,2\n")
    _, _, shaped, _ = _shape(spec, path)
    assert [r["v"] for r in shaped] == [2, 1]
    _, _, newest, truncated = _shape(spec, path, 1)
    assert truncated and newest[0]["v"] == 1
    impossible = _csv(tmp_path, "t,v\n2026-13-45,1\n", "bad.csv")
    with pytest.raises(ChartDataError, match="not a real date"):
        _shape(spec, impossible)


@pytest.mark.asyncio
async def test_a_file_past_the_read_cap_says_so(server, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("OMNIGENT_RUNNER_WORKSPACE", str(tmp_path))
    monkeypatch.setattr("omnigent.superchat.charts.data.READ_CAP", 30)
    monkeypatch.setattr("omnigent.superchat.charts.handlers.READ_CAP", 30)
    (tmp_path / "big.csv").write_text("m,v\n" + "\n".join(f"{i},{i}" for i in range(80)))
    out = json.loads(
        await handle_chart_tool(
            _ctx(server), _call("big.csv", x_axis_key="m", series=[{"data_key": "v"}])
        )
    )
    assert out["chart"]["truncated"] is True
    assert "only the first 30 were read" in out["note"]


def _date_parity() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[5] / "packages" / "charts" / "date-parity.json"
    return json.loads(path.read_text())


def _accepted_date(text: str) -> bool:
    shaped = _date_text(text)
    if shaped is None:
        return False
    try:
        _instant(shaped)
    except ValueError:
        return False
    return True


def test_the_date_set_matches_the_web_twin() -> None:
    """``packages/charts/src/date.ts`` reads the same file (date.test.ts): one definition."""
    parity = _date_parity()
    assert [t for t in parity["valid"] if not _accepted_date(t)] == []
    assert [t for t in parity["invalid"] if _accepted_date(t)] == []
    for text, utc in parity["instants"]:
        assert _instant(text) == _instant(utc)
