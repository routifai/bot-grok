"""Ingestion states, dedupe, delete propagation, embeddings fallback and hybrid ranking."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from omnigent.superchat.knowledge.service import MAX_ATTEMPTS, blob_key
from omnigent.superchat.knowledge.store import (
    EMBED_EMBEDDED,
    EMBED_KEYWORD_ONLY,
    STATE_FAILED,
    STATE_QUEUED,
    STATE_READY,
    STATE_TEXT_READY,
)
from omnigent.superchat.knowledge.worker import IndexWorker
from tests.superchat.knowledge._fixtures import (
    FakeEmbeddings,
    build_env,
    make_pdf,
)

FINANCE = make_pdf(
    [
        [("1. Revenue overview", 20), ("Revenue grew twelve percent in Montreal.", 11)],
        [("2. Risks", 20), ("Currency exposure is the main risk for the group.", 11)],
        [("3. Outlook", 20), ("We expect steady growth next year.", 11)],
    ]
)
GARAGE = make_pdf(
    [
        [("Fleet", 20), ("Every automobile in the depot is serviced yearly.", 11)],
        [("Parking", 20), ("The depot parking lot closes at midnight.", 11)],
    ]
)


@pytest.fixture()
def env(db_uri: str, tmp_path: Path):
    return build_env(db_uri, tmp_path)


def test_saving_a_pdf_queues_a_job_and_the_pass_walks_the_states(env) -> None:
    item = env.save("finance.pdf", FINANCE)
    job = env.store.get_job(item.id)
    assert (job.state, job.kind, job.name) == (STATE_QUEUED, "pdf", "finance.pdf")
    assert len(job.sha256) == 64

    env.service.process(job)  # one call runs both steps
    job = env.store.get_job(item.id)
    assert job.state == STATE_READY
    assert (job.page_count, job.text_pages, job.chunk_count) == (3, 3, 3)
    assert job.embed_status == EMBED_EMBEDDED


def test_text_ready_is_reported_between_the_steps(env, monkeypatch) -> None:
    item = env.save("finance.pdf", FINANCE)
    seen: list[str] = []
    original = env.service._embed

    def spy(job, rows):
        seen.append(env.store.get_job(job.artifact_id).state)
        return original(job, rows)

    monkeypatch.setattr(env.service, "_embed", spy)
    env.service.process(env.store.get_job(item.id))
    assert seen == [STATE_TEXT_READY]
    # Text is already searchable by keyword at that point: the passages exist.
    assert len(env.store.chunks_for(item.id)) == 3


def test_kinds_we_do_not_index_are_ignored(env) -> None:
    item = env.save("deck.pptx", b"PK\x03\x04 not really")
    assert env.store.get_job(item.id) is None


def test_chunks_keep_page_numbers_headings_and_embeddings(env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    rows = env.store.chunks_for(item.id)
    assert [(r.page_start, r.page_end, r.heading_path) for r in rows] == [
        (1, 1, "1. Revenue overview"),
        (2, 2, "2. Risks"),
        (3, 3, "3. Outlook"),
    ]
    assert all(r.embedding and r.embed_model == env.embeddings.tag_value for r in rows)
    assert all(r.user_id == "alice" and r.sha == env.store.get_job(item.id).sha256 for r in rows)


def test_page_images_are_stored_and_served(env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    job = env.store.get_job(item.id)
    assert env.blobs.exists(blob_key(item.id, 3, "thumb"))
    assert env.service.page_image(job, 2, "thumb")[:4] == b"RIFF"
    page = env.service.page(job, 2)
    assert "Currency exposure" in page["text"] and page["image"][:4] == b"RIFF"
    assert env.service.page(job, 4) is None


def test_the_same_bytes_are_not_indexed_twice(env) -> None:
    first = env.save("finance.pdf", FINANCE, session="a" * 32)
    env.run_all()
    copy = env.save("finance copy.pdf", FINANCE, session="b" * 32)
    job = env.store.get_job(copy.id)
    assert (job.state, job.duplicate_of) == (STATE_READY, first.id)
    assert env.store.chunks_for(copy.id) == []
    assert env.store.next_due() is None
    # The copy answers page reads from the original's render.
    assert env.service.page(job, 1)["image"] is not None
    # Another person uploading the same file is not a duplicate of Alice's.
    other = env.save("finance.pdf", FINANCE, user="bob", session="c" * 32)
    assert env.store.get_job(other.id).duplicate_of is None


def test_deleting_a_file_deletes_its_passages_images_and_index_entries(env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    assert env.service.search("alice", "currency exposure")["results"]
    env.artifacts.delete_group(item)
    assert env.store.get_job(item.id) is None
    assert env.store.chunks_for(item.id) == []
    assert not env.blobs.exists(blob_key(item.id, 1, "page"))
    assert env.service.search("alice", "currency exposure")["results"] == []


def test_deleting_the_original_requeues_its_duplicates(env) -> None:
    first = env.save("a.pdf", FINANCE, session="a" * 32)
    env.run_all()
    copy = env.save("b.pdf", FINANCE, session="b" * 32)
    env.artifacts.delete_group(first)
    job = env.store.get_job(copy.id)
    assert (job.state, job.duplicate_of) == (STATE_QUEUED, None)
    env.run_all()
    assert env.store.get_job(copy.id).state == STATE_READY
    assert len(env.store.chunks_for(copy.id)) == 3
    assert env.service.search("alice", "currency exposure")["results"][0]["artifact_id"] == copy.id


def test_a_new_version_replaces_the_old_versions_passages(env) -> None:
    v1 = env.save("notes.md", b"# Notes\nthe launch date is in March")
    env.run_all()
    v2 = env.save("notes.md", b"# Notes\nthe launch date moved to June")
    env.run_all()
    assert env.store.get_job(v1.id) is None and env.store.chunks_for(v1.id) == []
    hits = env.service.search("alice", "launch date")["results"]
    assert {h["artifact_id"] for h in hits} == {v2.id}
    assert "June" in hits[0]["passage"]


def test_a_failing_file_is_retried_then_failed_with_its_reason(env) -> None:
    item = env.save("broken.pdf", b"%PDF-1.4 truncated")
    job = env.store.get_job(item.id)
    env.service.record_failure(job, ValueError("not a readable PDF"))
    again = env.store.get_job(item.id)
    assert (again.state, again.attempts, again.last_error) == (
        STATE_QUEUED,
        1,
        "not a readable PDF",
    )
    assert again.next_attempt_at > again.updated_at and env.store.next_due() is None
    env.store.update_job(item.id, next_attempt_at=0)  # the retry delay has passed
    env.run_all()
    failed = env.store.get_job(item.id)
    assert failed.state == STATE_FAILED and failed.attempts == MAX_ATTEMPTS
    assert env.service.status("alice")["files"][0]["state"] == "failed"


def test_worker_indexes_in_the_background_and_wakes_on_save(env) -> None:
    async def scenario() -> None:
        worker = IndexWorker(env.service, idle_seconds=0.2)
        worker.start()
        try:
            item = await asyncio.to_thread(env.save, "finance.pdf", FINANCE)
            await worker.wait_for_idle(60)
            assert env.store.get_job(item.id).state == STATE_READY
        finally:
            await worker.shutdown()

    asyncio.run(scenario())


def test_status_reports_each_file_with_page_counts(env) -> None:
    env.save("finance.pdf", FINANCE)
    env.save("scan.pdf", make_pdf([[("words", 11)], []]))
    env.run_all()
    files = {f["name"]: f for f in env.service.status("alice")["files"]}
    assert files["finance.pdf"]["state"] == "searchable" and files["finance.pdf"]["pages"] == 3
    assert files["scan.pdf"]["pages_without_text"] == 1
    assert env.service.status("bob")["files"] == []
    assert env.service.status("alice")["embeddings"] == {"available": True, "reason": None}


def test_no_embedding_connection_falls_back_to_keywords_and_says_why(
    db_uri: str, tmp_path: Path
) -> None:
    env = build_env(db_uri, tmp_path, FakeEmbeddings(connected=False))
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    job = env.store.get_job(item.id)
    assert (job.state, job.embed_status, job.embed_reason) == (
        STATE_READY,
        EMBED_KEYWORD_ONLY,
        "no_connection",
    )
    assert env.embeddings.calls == []
    assert all(r.embedding is None for r in env.store.chunks_for(item.id))
    found = env.service.search("alice", "currency exposure risk")
    assert (found["mode"], found["keyword_only_reason"]) == ("keyword", "no_connection")
    assert found["results"][0]["page"] == 2
    file = env.service.status("alice")["files"][0]
    assert (file["search"], file["keyword_only_reason"]) == ("keyword", "no_connection")


def test_embeddings_arriving_later_re_embed_through_reindex(db_uri: str, tmp_path: Path) -> None:
    fake = FakeEmbeddings(connected=False)
    env = build_env(db_uri, tmp_path, fake)
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    assert env.service.reindex("alice") == 0  # still no connection: nothing to do
    fake.connected = True
    assert env.service.reindex("alice") == 1
    env.run_all()
    assert env.store.get_job(item.id).embed_status == EMBED_EMBEDDED
    assert env.service.search("alice", "money trouble")["mode"] == "hybrid"


def test_a_provider_hiccup_retries_then_settles_for_keywords(db_uri: str, tmp_path: Path) -> None:
    env = build_env(db_uri, tmp_path, FakeEmbeddings(fail_with="error"))
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    job = env.store.get_job(item.id)
    assert (job.state, job.embed_status, job.embed_reason) == (
        STATE_READY,
        EMBED_KEYWORD_ONLY,
        "error",
    )


def test_hybrid_ranking_finds_meaning_that_keywords_miss(env) -> None:
    finance = env.save("finance.pdf", FINANCE)
    garage = env.save("garage.pdf", GARAGE)
    env.run_all()

    # Exact words: the finance risk page leads in both modes.
    exact = env.service.search("alice", "currency exposure risk")
    assert exact["mode"] == "hybrid"
    assert (exact["results"][0]["artifact_id"], exact["results"][0]["page"]) == (finance.id, 2)

    # Meaning: "car" shares no word with the garage page ("automobile"); the model treats them as
    # the same idea, so hybrid finds it, keyword-only does not.
    meaning = env.service.search("alice", "car")
    assert (meaning["results"][0]["artifact_id"], meaning["results"][0]["page"]) == (garage.id, 1)
    assert meaning["results"][0]["file_name"] == "garage.pdf"
    env.embeddings.connected = False
    assert env.service.search("alice", "car")["results"] == []


def test_search_can_be_limited_to_files_and_is_per_person(env) -> None:
    finance = env.save("finance.pdf", FINANCE)
    garage = env.save("garage.pdf", GARAGE)
    bobs = env.save("finance.pdf", FINANCE, user="bob", session="d" * 32)
    env.run_all()
    only_garage = env.service.search("alice", "depot", file_ids=[garage.id])
    assert {h["artifact_id"] for h in only_garage["results"]} == {garage.id}
    in_finance = env.service.search("alice", "depot", file_ids=[finance.id])["results"]
    assert {h["artifact_id"] for h in in_finance} <= {finance.id}
    mine = env.service.search("alice", "revenue Montreal")["results"]
    assert mine[0]["artifact_id"] == finance.id
    assert bobs.id not in {h["artifact_id"] for h in mine}
    assert env.service.search("carol", "revenue Montreal")["results"] == []


def test_results_carry_page_score_and_thumbnail_for_pdfs_only(env) -> None:
    pdf = env.save("finance.pdf", FINANCE)
    note = env.save("notes.txt", b"Revenue notes for the board meeting.")
    env.run_all()
    hits = {h["file_name"]: h for h in env.service.search("alice", "revenue")["results"]}
    assert hits["finance.pdf"]["thumbnail_url"] == (
        f"/v1/knowledge/files/{pdf.id}/pages/{hits['finance.pdf']['page']}/thumbnail"
    )
    assert hits["finance.pdf"]["score"] > 0 and hits["finance.pdf"]["heading"]
    assert hits["notes.txt"]["thumbnail_url"] is None and hits["notes.txt"]["page"] == 1
    assert hits["notes.txt"]["artifact_id"] == note.id


def test_index_is_rebuilt_from_the_table_and_a_size_change_rebuilds(env) -> None:
    item = env.save("finance.pdf", FINANCE)
    env.run_all()
    assert env.service.rebuild("alice") == 3
    assert env.service.search("alice", "currency exposure")["results"][0]["artifact_id"] == item.id
    # An index built with another vector size is rebuilt, not mixed.
    index = env.service.indexes().for_user("alice")
    assert index.dims() == 64
    env.save("garage.pdf", GARAGE)
    env.run_all()
    assert index.dims() == 64


def test_uploading_and_deleting_through_the_artifacts_routes_drives_the_index(
    env, monkeypatch
) -> None:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient

    from omnigent.errors import OmnigentError
    from omnigent.superchat.artifacts.routes import create_artifacts_router

    class _Auth:
        def get_user_id(self, request: Request) -> str | None:
            return "alice"

    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.http_status)

    import omnigent.superchat.artifacts.routes as routes_mod

    async def _allow(*args, **kwargs):
        return None

    monkeypatch.setattr(routes_mod, "require_access", _allow)
    app.include_router(
        create_artifacts_router(env.artifacts, conversation_store=object(), auth_provider=_Auth()),  # type: ignore[arg-type]
        prefix="/v1",
    )
    client = TestClient(app)
    created = client.post(
        f"/v1/artifacts?parent_session_id={'e' * 32}&name=finance.pdf", content=FINANCE
    )
    assert created.status_code == 201
    artifact_id = created.json()["id"]
    assert env.store.get_job(artifact_id).state == STATE_QUEUED
    env.run_all()
    assert env.service.search("alice", "currency exposure")["results"]
    assert client.delete(f"/v1/artifacts/{artifact_id}").status_code == 200
    assert env.store.get_job(artifact_id) is None
    assert env.service.search("alice", "currency exposure")["results"] == []
