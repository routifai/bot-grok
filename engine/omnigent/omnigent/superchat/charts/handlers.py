"""Runner-side handler for ``display_chart``.

Runs where the Computer's files are: validates the call, reads the result file named by
``source``, checks every column name against it and saves the chart (a JSON spec plus a data
snapshot) as an artifact named ``*.chart.json``. The same name in the same chat is a new version.
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
from omnigent.superchat.charts.names import chart_file_name
from omnigent.superchat.charts.spec import ChartSpec, DisplayChartInput
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


def prepare_chart(args: dict[str, Any]) -> tuple[DisplayChartInput, dict[str, Any]] | str:
    """Validate a call and read its data: ``(call, document)``, or a sentence for the model."""
    try:
        call = DisplayChartInput.model_validate(args)
    except ValidationError as exc:
        return _validation_message(exc)
    file = resolve_workspace_file(call.source.path.strip(), workspace_roots())
    if isinstance(file, str):
        return file
    try:
        columns, rows, cut = read_rows(file)
        spec = ChartSpec.model_validate(call.model_dump(exclude={"source", "name"}))
        spec, kept, shaped, truncated = shape_rows(
            spec, columns, rows, call.source.columns, call.source.max_rows, cut=cut
        )
    except ChartDataError as exc:
        return str(exc)
    except ValidationError as exc:
        return _validation_message(exc)
    document = build_document(
        source_name=file.name,
        source_path=_workspace_relative(file),
        truncated=truncated,
        read_cut=cut,
        spec=spec,
        kept=kept,
        rows=shaped,
    )
    return call, document


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
        return error("The chart data is too large; aggregate it further or lower max_rows")
    name = chart_file_name(call.name, call.title)
    url = (
        f"/v1/artifacts?parent_session_id={chat_id}&name={quote(name)}"
        f"&title={quote(call.title[:256])}"
    )
    try:
        resp = await caller.client.post(
            url,
            content=data,
            headers={"Content-Type": "application/octet-stream"},
            timeout=120.0,
        )
    except Exception as exc:  # noqa: BLE001
        return error(f"display_chart failed: {exc}")
    if resp.status_code >= 400:
        return finish(resp)
    source = document["source"]
    note = "The chart is shown to the person. Cite the source file and what you computed."
    if source["read_cut"]:
        note += (
            f" WARNING: the file has more than {READ_CAP} rows and only the first {READ_CAP} were "
            "read, so the chart covers just those (a date chart shows the newest of them). "
            "Aggregate it in code and chart the result to cover everything."
        )
    elif source["truncated"]:
        note += f" The chart shows {source['rows']} of the file's rows; say so if it matters."
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
