"""Runner-side handlers for ``display_chart`` and ``display_dashboard``.

Run where the Computer's files are: validate the call, read each result file named by a
``source``, check every column name against it and save the chart (a JSON spec plus a data
snapshot) as an artifact named ``*.chart.json``, or a dashboard (a title, KPI tiles and charts,
each such a chart document) as one artifact named ``*.dashboard.json``. The same name in the same
chat is a new version.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import ValidationError

from omnigent.superchat._handler_http import error, finish, resolve_caller
from omnigent.superchat.artifact_kinds import MAX_ARTIFACT_BYTES
from omnigent.superchat.artifacts import resolve_workspace_file, workspace_roots
from omnigent.superchat.charts.data import READ_CAP, ChartDataError, read_rows, shape_rows
from omnigent.superchat.charts.names import chart_file_name, dashboard_file_name
from omnigent.superchat.charts.spec import (
    ChartSource,
    ChartSpec,
    DisplayChartInput,
    DisplayDashboardInput,
)
from omnigent.superchat.feature import HandlerCtx

#: The saved document's format version (the web viewer and the thumbnail render read it).
DOCUMENT_VERSION = 1


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for item in exc.errors()[:6]:
        where = ".".join(str(p) for p in item["loc"]) or "input"
        parts.append(f"{where}: {item['msg'].removeprefix('Value error, ')}")
    return "Invalid chart: " + "; ".join(parts)


def build_document(
    *, source_name: str, source_path: str, truncated: bool, read_cut: bool, spec: ChartSpec,
    kept: list[str], rows: list[dict[str, Any]],
) -> dict[str, Any]:  # fmt: skip
    """The chart artifact's JSON: the spec (no source), where the data came from, the rows."""
    return {
        "version": DOCUMENT_VERSION,
        "spec": spec.model_dump(exclude_none=True),
        "source": {
            "file": source_name,
            "path": source_path,
            "columns": kept,
            "rows": len(rows),
            "truncated": truncated,
            "read_cut": read_cut,
        },
        "data": rows,
    }


def _workspace_relative(file: Path) -> str:
    """The file's path inside its workspace root (never an absolute path of the Computer)."""
    for root in workspace_roots():
        if file.is_relative_to(root):
            return file.relative_to(root).as_posix()
    return file.name


def _chart_document(fields: dict[str, Any], source: ChartSource) -> dict[str, Any] | str:
    """A chart document from a spec's fields and its result file, or a sentence for the model."""
    file = resolve_workspace_file(source.path.strip(), workspace_roots())
    if isinstance(file, str):
        return file
    try:
        columns, rows, cut = read_rows(file)
        spec = ChartSpec.model_validate(fields)
        spec, kept, shaped, truncated = shape_rows(
            spec, columns, rows, source.columns, source.max_rows, cut=cut
        )
    except ChartDataError as exc:
        return str(exc)
    except ValidationError as exc:
        return _validation_message(exc)
    return build_document(
        source_name=file.name,
        source_path=_workspace_relative(file),
        truncated=truncated,
        read_cut=cut,
        spec=spec,
        kept=kept,
        rows=shaped,
    )


def prepare_chart(args: dict[str, Any]) -> tuple[DisplayChartInput, dict[str, Any]] | str:
    """Validate a call and read its data: ``(call, document)``, or a sentence for the model."""
    try:
        call = DisplayChartInput.model_validate(args)
    except ValidationError as exc:
        return _validation_message(exc)
    document = _chart_document(call.model_dump(exclude={"source", "name"}), call.source)
    return document if isinstance(document, str) else (call, document)


def prepare_dashboard(args: dict[str, Any]) -> tuple[DisplayDashboardInput, dict[str, Any]] | str:
    """Validate a dashboard call and read each chart's data: ``(call, document)`` or a sentence."""
    try:
        call = DisplayDashboardInput.model_validate(args)
    except ValidationError as exc:
        return _validation_message(exc).replace("Invalid chart:", "Invalid dashboard:", 1)
    kpis: list[dict[str, Any]] = []
    charts: list[dict[str, Any]] = []
    for where, items, out in (("kpis", call.kpis, kpis), ("charts", call.charts, charts)):
        for index, item in enumerate(items):
            document = _chart_document(item.chart_fields(), item.source)
            if isinstance(document, str):
                return f"{where}[{index}] ({item.title}): {document}"
            if where == "charts" and getattr(item, "wide", None):
                document["wide"] = True
            out.append(document)
    dashboard: dict[str, Any] = {
        "version": DOCUMENT_VERSION,
        "title": call.title,
        "kpis": kpis,
        "charts": charts,
    }
    if call.layout:
        dashboard["layout"] = call.layout
    return call, dashboard


def _too_large(what: str) -> str:
    return error(f"The {what} data is too large; aggregate it further or lower max_rows")


def _source_note(source: dict[str, Any], what: str) -> str:
    """What the model must say about a chart whose file was cut, or ``""``."""
    if source["read_cut"]:
        return (
            f" WARNING: {what} reads a file with more than {READ_CAP} rows and only the first "
            f"{READ_CAP} were read, so it covers just those (a date chart shows the newest of "
            "them). Aggregate it in code and chart the result to cover everything."
        )
    if source["truncated"]:
        return f" {what} shows {source['rows']} of its file's rows; say so if it matters."
    return ""


async def _save(caller: Any, chat_id: str, name: str, title: str, data: bytes) -> Any:
    """POST the document as the chat's artifact ``name`` (same name: a new version)."""
    url = (
        f"/v1/artifacts?parent_session_id={chat_id}&name={quote(name)}&title={quote(title[:256])}"
    )
    return await caller.client.post(
        url,
        content=data,
        headers={"Content-Type": "application/octet-stream"},
        timeout=120.0,
    )


async def handle_chart_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run ``display_chart``: read the result file, build the chart document, save it.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string (``{"type": "artifact", ...}`` for the saved chart).
    """
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    chat_id = caller.chat_id
    if not chat_id:
        return error("display_chart: no chat to attach to")
    prepared = await asyncio.to_thread(prepare_chart, args)
    if isinstance(prepared, str):
        return error(prepared)
    call, document = prepared
    data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_ARTIFACT_BYTES:
        return _too_large("chart")
    name = chart_file_name(call.name, call.title)
    try:
        resp = await _save(caller, chat_id, name, call.title, data)
    except Exception as exc:  # noqa: BLE001
        return error(f"display_chart failed: {exc}")
    if resp.status_code >= 400:
        return finish(resp)
    source = document["source"]
    note = "The chart is shown to the person. Cite the source file and what you computed."
    note += _source_note(source, "The chart")
    return json.dumps(
        {
            "type": "artifact",
            **resp.json(),
            "chart": {
                "chart_type": call.chart_type,
                "rows": source["rows"],
                "columns": source["columns"],
                "truncated": source["truncated"],
                "source": source["file"],
            },
            "note": note,
        }
    )


async def handle_dashboard_tool(ctx: HandlerCtx, args: dict[str, Any]) -> str:
    """
    Run ``display_dashboard``: read every chart's result file, save one dashboard document.

    :param ctx: The call context.
    :param args: Parsed tool arguments.
    :returns: Tool output JSON string (``{"type": "artifact", ...}`` for the saved dashboard).
    """
    caller = await resolve_caller(ctx)
    if isinstance(caller, str):
        return caller
    chat_id = caller.chat_id
    if not chat_id:
        return error("display_dashboard: no chat to attach to")
    prepared = await asyncio.to_thread(prepare_dashboard, args)
    if isinstance(prepared, str):
        return error(prepared)
    call, document = prepared
    data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) > MAX_ARTIFACT_BYTES:
        return _too_large("dashboard")
    name = dashboard_file_name(call.name, call.title)
    try:
        resp = await _save(caller, chat_id, name, call.title, data)
    except Exception as exc:  # noqa: BLE001
        return error(f"display_dashboard failed: {exc}")
    if resp.status_code >= 400:
        return finish(resp)
    note = (
        "The dashboard is shown to the person as one card. Cite the source files and what you "
        "computed; do not repeat its numbers chart by chart."
    )
    for item in (*document["kpis"], *document["charts"]):
        note += _source_note(item["source"], f"'{item['spec']['title']}'")
    return json.dumps(
        {
            "type": "artifact",
            **resp.json(),
            "dashboard": {
                "kpis": len(document["kpis"]),
                "charts": [item["spec"]["chart_type"] for item in document["charts"]],
                "sources": sorted(
                    {item["source"]["file"] for item in (*document["kpis"], *document["charts"])}
                ),
            },
            "note": note,
        }
    )
