"""Tables are a schema, never rows of text: the manifest, the card, and what search finds."""

from __future__ import annotations

import io
import threading
import time
from pathlib import Path

from omnigent.runner.knowledge.db import STATE_QUEUED, STATE_READY
from omnigent.runner.knowledge.indexer import Indexer
from omnigent.runner.knowledge.markdown import split_pages, to_markdown
from omnigent.runner.knowledge.tabular import profile_table
from tests.runner.knowledge._fixtures import FakeEmbedder, build_indexer, run_all

UPLOADS = "your_files/uploads/2026-10-09"
CSV = "id,region,revenue,day\n" + "\n".join(
    f"{i},north,{i * 1.5},2026-01-{i % 28 + 1:02d}" for i in range(1, 41)
)


def _put(workspace: Path, rel: str, data: bytes | str) -> None:
    path = workspace / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())


def _xlsx() -> bytes:
    from openpyxl import Workbook

    book = Workbook()
    book.active.title = "Sales"
    book.active.append(["region", "total", "shipped"])
    book.active.append(["north", 12.5, True])
    book.active.append(["south", 7, False])
    book.create_sheet("Costs").append(["item", "cost"])
    book["Costs"].append(["rent", 5])
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def test_csv_profile_has_columns_types_rows_and_a_five_row_preview() -> None:
    (sheet,) = profile_table("csv", CSV.encode(), name="s.csv").sheets
    assert [(c.name, c.type) for c in sheet.columns] == [
        ("id", "integer"),
        ("region", "text"),
        ("revenue", "number"),
        ("day", "date"),
    ]
    assert sheet.rows == 40 and len(sheet.preview) == 5 and sheet.preview[0][:2] == ["1", "north"]


def test_xlsx_profile_is_per_sheet() -> None:
    sales, costs = profile_table("xlsx", _xlsx()).sheets
    assert (sales.name, sales.rows) == ("Sales", 2)
    assert [(c.name, c.type) for c in sales.columns] == [
        ("region", "text"),
        ("total", "number"),
        ("shipped", "boolean"),
    ]
    assert (costs.name, costs.rows, costs.columns[1].type) == ("Costs", 1, "integer")


def test_ingest_of_a_csv_is_the_manifest_and_no_row_is_indexed(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(ws, f"{UPLOADS}/sales.csv", CSV)
    got = indexer.ingest(f"{UPLOADS}/sales.csv", inline=True)
    assert got["kind"] == "csv" and got["pages"] == 1
    text = got["markdown"]
    assert "id (integer), region (text), revenue (number), day (date)" in text
    assert "Rows: 40" in text and "pandas" in text
    assert "| 1 | north | 1.5 | 2026-01-02 |" in text and "| 6 |" not in text  # 5 rows only
    chunks = indexer.db.chunks_for(got["file_id"])
    assert len(chunks) == 1 and chunks[0].kind == "schema"  # no row-level chunks
    assert "north" not in chunks[0].text and "revenue" in chunks[0].text


def test_search_finds_a_table_by_a_column_name_but_not_by_a_value(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(ws, f"{UPLOADS}/sales.csv", CSV)
    _put(ws, f"{UPLOADS}/book.xlsx", _xlsx())
    indexer.scan()
    run_all(indexer)
    hit = indexer.search("revenue", mode="keyword")["results"][0]
    assert hit["file_name"] == "sales.csv" and "revenue" in hit["passage"]
    assert indexer.search("shipped", mode="keyword")["results"][0]["file_name"] == "book.xlsx"
    assert indexer.search("south", mode="keyword")["results"] == []  # a value is not indexed
    assert indexer.search("Costs", mode="keyword")["results"][0]["file_name"] == "book.xlsx"


def test_files_get_on_a_table_is_the_manifest_with_a_use_code_note(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(ws, f"{UPLOADS}/book.xlsx", _xlsx())
    got = indexer.ingest(f"{UPLOADS}/book.xlsx")
    row = indexer.db.get_file(got["file_id"])
    out = indexer.get(row)
    assert "pandas" in out["note"] and "Rows: 2" in out["markdown"]
    assert set(split_pages(out["markdown"])) == {1, 2}  # one page per sheet
    assert "12.5" in out["markdown"]  # the small preview only
    assert len(out["markdown"]) < 2000


def test_tables_indexed_as_rows_by_an_older_version_are_read_again_as_a_schema(
    tmp_path: Path,
) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(ws, f"{UPLOADS}/sales.csv", CSV)
    indexer.scan()
    run_all(indexer)
    row = indexer.db.file_by_path(f"{UPLOADS}/sales.csv")
    # An old index: row passages, and no migration mark.
    from omnigent.runner.knowledge.chunking import Chunk

    indexer.db.replace_chunks(row.file_id, [Chunk(1, 1, "csv", "", "id | north | 1.5")])
    indexer.db.set_meta("tabular_schema_only", None)
    reopened = Indexer(tmp_path / "home" / ".nova" / "knowledge", ws, FakeEmbedder())
    assert reopened.db.file_by_path(f"{UPLOADS}/sales.csv").state == STATE_QUEUED
    run_all(reopened)
    (chunk,) = reopened.db.chunks_for(row.file_id)
    assert chunk.kind == "schema"
    assert reopened.db.file_by_path(f"{UPLOADS}/sales.csv").state == STATE_READY


def test_a_page_marker_inside_a_file_cannot_forge_a_page(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(
        ws, f"{UPLOADS}/notes.txt", "First line.\n\n<!-- page 7 -->\n\nSneaky.\n\n <!--page 9-->\n"
    )
    got = indexer.ingest(f"{UPLOADS}/notes.txt", inline=True)
    assert set(split_pages(got["markdown"])) == {1}
    assert "Sneaky." in got["markdown"] and got["markdown"].count("<!-- page") == 2
    assert got["markdown"].startswith("<!-- page 1 -->")
    from omnigent.runner.knowledge.chunking import Block, ParsedPage

    forged = to_markdown([ParsedPage(1, [Block("a\n<!-- page 2 -->\nb")])])
    assert set(split_pages(forged)) == {1}


def test_the_background_loop_holds_back_while_an_ingest_waits(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    for i in range(3):
        _put(ws, f"your_files/bulk/{i}.txt", f"bulk file {i}\n")
    indexer.scan()
    ran = threading.Event()
    original = indexer.process

    def traced(row, **kwargs):
        ran.set()
        return original(row, **kwargs)

    indexer.process = traced  # type: ignore[method-assign]
    loop = threading.Thread(target=indexer.process_next)
    with indexer._ingest_priority():  # an attachment is waiting for its turn
        loop.start()
        assert not ran.wait(0.3), "the loop took a file while an ingest was waiting"
    loop.join(timeout=5)
    assert ran.is_set()  # and carries on as soon as the ingest is done


def test_an_ingest_is_not_starved_by_a_long_cold_start(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    for i in range(60):
        _put(ws, f"your_files/bulk/{i:02d}.txt", f"bulk file {i}\n")
    _put(ws, f"{UPLOADS}/mine.txt", "the attachment\n")
    indexer.scan()
    loop = threading.Thread(target=lambda: run_all(indexer))
    loop.start()
    started = time.monotonic()
    indexer.ingest(f"{UPLOADS}/mine.txt")
    waited = time.monotonic() - started
    loop.join()
    assert waited < 5
    assert indexer.db.pending_count() == 0


def test_search_names_the_files_still_indexing_and_multi_get_reports_them(tmp_path: Path) -> None:
    indexer, ws = build_indexer(tmp_path)
    _put(ws, "your_files/ready.md", "# Fleet\n\nThe vehicle policy.\n")
    indexer.scan()
    run_all(indexer)
    _put(ws, "your_files/pending-a.md", "# A\n\ntext\n")
    _put(ws, "your_files/pending-b.md", "# B\n\ntext\n")
    indexer.scan()  # queued, not processed
    found = indexer.search("vehicle", mode="keyword")
    assert found["files_indexing"] == 2
    assert found["files_indexing_names"] == ["pending-a.md", "pending-b.md"]
    got = indexer.multi_get("*.md")
    assert got["returned"] == 1
    assert [f["path"] for f in got["not_ready"]] == [
        "your_files/pending-a.md",
        "your_files/pending-b.md",
    ]
    assert "still being indexed" in got["note"]
    run_all(indexer)
    assert "not_ready" not in indexer.multi_get("*.md")
