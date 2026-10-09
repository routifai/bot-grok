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
from omnigent.superchat.charts.data import ChartDataError, read_rows, shape_rows
from omnigent.superchat.charts.feature import CHARTS_FEATURE
from omnigent.superchat.charts.handlers import handle_chart_tool
from omnigent.superchat.charts.names import chart_file_name
from omnigent.superchat.charts.spec import CHART_TYPES, ChartSpec, DisplayChartInput
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


def test_read_csv_and_shape(tmp_path: Path) -> None:
    path = tmp_path / "r.csv"
    path.write_text(CSV)
    columns, rows, truncated = read_rows(path, None)
    assert columns == ["month", "revenue", "margin"] and len(rows) == 4 and not truncated
    spec = ChartSpec.model_validate(
        {k: v for k, v in _call("r.csv").items() if k != "source"} | {"x_axis_key": "MONTH"}
    )
    resolved, kept, shaped = shape_rows(spec, columns, rows, None)
    assert resolved.x_axis_key == "month" and kept == ["month", "revenue"]
    assert shaped[0] == {"month": "2026-01", "revenue": 100}
    assert shaped[2]["revenue"] is None  # an empty cell stays a gap


def test_row_cap_and_truncation(tmp_path: Path) -> None:
    path = tmp_path / "big.csv"
    path.write_text("x,y\n" + "\n".join(f"{i},{i}" for i in range(50)))
    _, rows, truncated = read_rows(path, 10)
    assert len(rows) == 10 and truncated


def test_unknown_column_lists_the_real_ones(tmp_path: Path) -> None:
    path = tmp_path / "r.csv"
    path.write_text(CSV)
    columns, rows, _ = read_rows(path, None)
    spec = ChartSpec.model_validate(
        {k: v for k, v in _call("r.csv").items() if k != "source"}
        | {"series": [{"data_key": "revenu"}]}
    )
    with pytest.raises(ChartDataError, match=r"'revenu'.*Columns: month, revenue, margin"):
        shape_rows(spec, columns, rows, None)


def test_non_numeric_series_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "r.csv"
    path.write_text(CSV)
    columns, rows, _ = read_rows(path, None)
    spec = ChartSpec.model_validate(
        {k: v for k, v in _call("r.csv").items() if k != "source"}
        | {"series": [{"data_key": "month"}]}
    )
    with pytest.raises(ChartDataError, match="numeric"):
        shape_rows(spec, columns, rows, None)


def test_json_shapes(tmp_path: Path) -> None:
    rows = [{"a": 1, "b": 2}, {"a": 3, "b": float("nan")}]
    (tmp_path / "list.json").write_text(json.dumps(rows))
    (tmp_path / "wrapped.json").write_text(json.dumps({"rows": rows}))
    (tmp_path / "cols.json").write_text(json.dumps({"a": [1, 3], "b": [2, None]}))
    (tmp_path / "lines.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    for name in ("list.json", "wrapped.json", "cols.json", "lines.jsonl"):
        columns, got, _ = read_rows(tmp_path / name, None)
        assert columns == ["a", "b"] and len(got) == 2, name
        assert got[1]["b"] is None, name  # NaN never reaches the JSON document


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
            read_rows(tmp_path / name, None)


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
    assert "inside your workspace" in escaped["error"] or "not found" in escaped["error"]
