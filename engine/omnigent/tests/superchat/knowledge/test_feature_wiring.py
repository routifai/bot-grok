"""The feature's own wiring: install mounts the routes and listeners, the job indexes in the
background, and nothing needs an embedding connection (keyword-only is the default)."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from omnigent.runtime import _globals
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.artifacts import SqlAlchemyArtifactStore
from omnigent.superchat.feature import InstallDeps
from omnigent.superchat.knowledge import FEATURE
from tests.superchat.knowledge._fixtures import SESSION, make_pdf


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return "alice"


@pytest.fixture()
def app(db_uri: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    monkeypatch.setattr(_globals, "_artifact_store", blobs)
    app = FastAPI()
    FEATURE.install(  # type: ignore[misc]
        app,
        InstallDeps(
            scheduled_task_store=SimpleNamespace(storage_location=db_uri),
            conversation_store=None,
            agent_store=None,
            permission_store=None,
            auth_provider=_Auth(),
        ),
    )
    app.state.blobs = blobs
    return app


def test_install_mounts_the_routes_and_follows_artifact_saves(app: FastAPI, db_uri: str) -> None:
    jobs = FEATURE.jobs(app)  # type: ignore[misc]
    assert len(jobs) == 1 and app.state.knowledge_worker is jobs[0]
    store = SqlAlchemyArtifactStore(db_uri, lambda: app.state.blobs)
    with TestClient(app) as client:
        asyncio.run(_run_job(jobs[0], store, client))


async def _run_job(worker, store: SqlAlchemyArtifactStore, client: TestClient) -> None:
    worker.start()
    try:
        item = await asyncio.to_thread(
            store.create,
            user_id="alice",
            parent_session_id=SESSION,
            name="finance.pdf",
            title=None,
            kind="pdf",
            mime=KIND_MIME["pdf"],
            data=make_pdf([[("2. Risks", 20), ("Currency exposure is the main risk.", 11)]]),
        )
        deadline = time.monotonic() + 60
        status: dict = {}
        while time.monotonic() < deadline:
            status = (await asyncio.to_thread(client.get, "/v1/knowledge/status")).json()
            if status["files"] and status["files"][0]["state"] == "searchable":
                break
            await asyncio.sleep(0.1)
        file = status["files"][0]
        assert (file["artifact_id"], file["pages"], file["search"]) == (item.id, 1, "keyword")
        assert status["embeddings"] == {"available": False, "reason": "no_connection"}
        found = (
            await asyncio.to_thread(
                client.post, "/v1/knowledge/search", json={"query": "currency exposure"}
            )
        ).json()
        assert found["mode"] == "keyword" and found["results"][0]["page"] == 1
    finally:
        await worker.shutdown()
