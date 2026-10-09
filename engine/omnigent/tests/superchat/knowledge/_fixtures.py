"""Shared pieces of the knowledge tests: tiny PDFs, a fake embedding layer, a wired service."""

from __future__ import annotations

import io
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import numpy as np

from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.artifacts import SqlAlchemyArtifactStore
from omnigent.superchat.knowledge.service import KnowledgeService
from omnigent.superchat.knowledge.store import KnowledgeStore
from omnigent.superchat.models import EmbeddingUnavailable
from omnigent.superchat.models.embeddings import EmbeddingResult, EmbeddingSetting

SESSION = uuid.uuid4().hex
DIMS = 64

#: Words the fake model treats as the same idea (a stand-in for meaning).
SYNONYMS = {
    "car": "vehicle",
    "automobile": "vehicle",
    "vehicle": "vehicle",
    "money": "currency",
    "cash": "currency",
    "currency": "currency",
}


def make_pdf(pages: list[list[tuple[str, int]]]) -> bytes:
    """A PDF with one page per list of ``(line, font size)``; no ML, no scans."""
    from reportlab.pdfgen import canvas

    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(595, 842))
    for lines in pages:
        y = 780
        for text, size in lines:
            pdf.setFont("Helvetica-Bold" if size > 12 else "Helvetica", size)
            pdf.drawString(72, y, text)
            y -= size + 8
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def concept_vector(text: str) -> list[float]:
    """Deterministic bag of concepts: a word and its synonyms land in the same slot."""
    vector = np.zeros(DIMS, dtype=np.float32)
    for word in text.lower().replace("\n", " ").split():
        word = "".join(ch for ch in word if ch.isalnum())
        if not word:
            continue
        concept = SYNONYMS.get(word, word)
        vector[int.from_bytes(concept.encode()[:4].ljust(4, b"\0"), "big") % DIMS] += 1.0
    norm = float(np.linalg.norm(vector))
    return (vector / norm if norm else vector).tolist()


@dataclass
class FakeEmbeddings:
    """Stands in for the model layer's ``ModelEmbeddings`` (no network, no keys)."""

    connected: bool = True
    reason: str = "no_connection"
    fail_with: str | None = None
    calls: list[list[str]] = field(default_factory=list)
    tag_value: str = "openrouter:fake-embed:64"

    def setting(self) -> EmbeddingSetting:
        return EmbeddingSetting(model="fake-embed", dimensions=DIMS)

    def available(self, owner_id: str) -> str | None:
        return None if self.connected else self.reason

    def tag(self, owner_id: str) -> str | None:
        return self.tag_value if self.connected else None

    def embed(self, owner_id: str, texts: list[str]) -> EmbeddingResult:
        if not self.connected:
            raise EmbeddingUnavailable(self.reason, "no connection")
        if self.fail_with:
            raise EmbeddingUnavailable(self.fail_with, "boom")
        self.calls.append(list(texts))
        return EmbeddingResult([concept_vector(t) for t in texts], self.tag_value, len(texts), 0.0)


@dataclass
class Env:
    service: KnowledgeService
    artifacts: SqlAlchemyArtifactStore
    store: KnowledgeStore
    blobs: LocalArtifactStore
    embeddings: FakeEmbeddings

    def save(self, name: str, data: bytes, *, user: str | None = "alice", session: str = SESSION):
        kind = name.rsplit(".", 1)[1]
        return self.artifacts.create(
            user_id=user,
            parent_session_id=session,
            name=name,
            title=None,
            kind=kind,
            mime=KIND_MIME[kind],
            data=data,
        )

    def run_all(self) -> None:
        """Run every due job to the end, as the worker would."""
        while (job := self.store.next_due()) is not None:
            try:
                self.service.process(job)
            except Exception as exc:
                self.service.record_failure(job, exc)
                self.store.update_job(job.artifact_id, next_attempt_at=0)


def build_env(db_uri: str, tmp_path: Path, embeddings: FakeEmbeddings | None = None) -> Env:
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    artifacts = SqlAlchemyArtifactStore(db_uri, lambda: blobs)
    store = KnowledgeStore(db_uri)
    fake = embeddings or FakeEmbeddings()
    service = KnowledgeService(
        store, artifacts, lambda: blobs, lambda: fake, index_root=tmp_path / "index"
    )
    from omnigent.superchat.artifacts import subscribe_created, subscribe_deleted

    subscribe_created(service.on_created)
    subscribe_deleted(service.on_deleted)
    return Env(service, artifacts, store, blobs, fake)
