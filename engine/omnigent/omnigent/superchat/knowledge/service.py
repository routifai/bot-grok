"""The knowledge service: index a file, search a person's files, serve their pages.

One pass per file, in two steps the job state shows. ``queued -> text_ready``: parse, cut into
passages with page numbers, store them and make them keyword-searchable. ``text_ready -> ready``:
embed the passages through the person's model connection (keyword-only, with the reason, when they
have none), render the page images, update the search index. Blocking by design: the worker runs it
in a thread.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Collection, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

import numpy as np

from omnigent.db.utils import now_epoch
from omnigent.stores.artifact_store import ArtifactStore
from omnigent.superchat.artifacts import Artifact, SqlAlchemyArtifactStore
from omnigent.superchat.knowledge.chunking import chunk_pages
from omnigent.superchat.knowledge.index import IndexedChunk, KnowledgeIndexes
from omnigent.superchat.knowledge.parse import INDEXABLE_KINDS, parse_file
from omnigent.superchat.knowledge.pdf import render_pages
from omnigent.superchat.knowledge.store import (
    EMBED_EMBEDDED,
    EMBED_KEYWORD_ONLY,
    STATE_FAILED,
    STATE_QUEUED,
    STATE_READY,
    STATE_TEXT_READY,
    Job,
    KnowledgeStore,
    StoredChunk,
)
from omnigent.superchat.models import (
    DEFAULT_EMBEDDING_DIMENSIONS,
    REASON_ERROR,
    REASON_NO_CONNECTION,
    EmbeddingUnavailable,
    ModelEmbeddings,
)

_logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = 30
DEFAULT_K = 8
MAX_K = 25
_BLOB_PREFIX = "knowledge"
#: Longest passage returned to the model, in characters.
_PASSAGE_CHARS = 1600


def blob_key(artifact_id: str, page: int, variant: str) -> str:
    """Artifact-store key of a page render (``variant``: ``thumb`` or ``page``)."""
    return f"{_BLOB_PREFIX}/{artifact_id}/{page:05d}.{variant}.webp"


def search_text(heading_path: str, text: str) -> str:
    """What BM25 and the embedding see for a passage: its headings, then its text."""
    if heading_path and not text.startswith(heading_path.rsplit(" > ", 1)[-1]):
        return f"{heading_path}\n{text}"
    return text


def _vector_bytes(vector: Sequence[float]) -> bytes:
    return np.asarray(vector, dtype=np.float32).tobytes()


def _from_bytes(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


class KnowledgeService:
    """Indexes files and answers searches; see the module docstring."""

    def __init__(
        self,
        store: KnowledgeStore,
        artifacts: SqlAlchemyArtifactStore,
        blobs: Callable[[], ArtifactStore | None],
        embeddings: Callable[[], ModelEmbeddings | None],
        *,
        index_root: Path | None = None,
        wake: Callable[[], None] = lambda: None,
    ) -> None:
        """
        :param blobs: Returns the engine's blob store (page renders live there).
        :param embeddings: Returns the model layer's embeddings, or ``None`` without one.
        :param index_root: Where the per-user indexes are kept; defaults to a ``knowledge_index``
            directory beside the blob store's files.
        :param wake: Tells the worker there is something to do.
        """
        self.store = store
        self._artifacts = artifacts
        self._blobs = blobs
        self._embeddings = embeddings
        self._index_root = index_root
        self._indexes: KnowledgeIndexes | None = None
        self._wake = wake

    def set_wake(self, wake: Callable[[], None]) -> None:
        """Set the worker's wake-up call (the worker is built after the service)."""
        self._wake = wake

    # ------------------------------------------------------------------ plumbing

    def _blob_store(self) -> ArtifactStore:
        blobs = self._blobs()
        if blobs is None:
            raise RuntimeError("artifact blob store is not configured")
        return blobs

    def indexes(self) -> KnowledgeIndexes:
        """The per-user indexes (created on first use)."""
        if self._indexes is None:
            root = (
                self._index_root or Path(self._blob_store().storage_location) / "knowledge_index"
            )
            self._indexes = KnowledgeIndexes(root)
        return self._indexes

    @staticmethod
    def _owner_key(user_id: str | None) -> str:
        from omnigent.server.auth import RESERVED_USER_LOCAL

        return user_id or RESERVED_USER_LOCAL

    def _current_tag(self, user_id: str | None) -> str | None:
        embeddings = self._embeddings()
        return embeddings.tag(self._owner_key(user_id)) if embeddings is not None else None

    def _dims(self, chunks: Collection[StoredChunk]) -> int:
        for chunk in chunks:
            if chunk.embedding:
                return len(chunk.embedding) // 4
        embeddings = self._embeddings()
        setting = embeddings.setting() if embeddings is not None else None
        return (setting.dimensions if setting else None) or DEFAULT_EMBEDDING_DIMENSIONS

    # ------------------------------------------------------------------ artifact events

    def on_created(self, item: Artifact, data: bytes, siblings: Sequence[str]) -> None:
        """A version was saved: queue it when it is a kind we index."""
        if item.kind not in INDEXABLE_KINDS or not data:
            return
        job = self.store.enqueue(
            user_id=item.user_id,
            artifact_id=item.id,
            name=item.name,
            kind=item.kind,
            sha256=hashlib.sha256(data).hexdigest(),
            same_group=siblings,
        )
        if job.state == STATE_READY:  # the same bytes are already indexed under another file
            self._supersede_older(item)
        self._wake()

    def on_deleted(self, items: Sequence[Artifact]) -> None:
        """A deliverable was deleted: drop its passages, images and index entries."""
        for item in items:
            self.forget(item.id, item.user_id)
        self._wake()

    def forget(self, artifact_id: str, user_id: str | None) -> None:
        """Remove everything the index holds for one artifact version.

        Files that pointed at it as their duplicate source go back to the queue.
        """
        dependents = self.store.dependents(artifact_id)
        chunk_ids, job = self.store.remove_artifact(artifact_id)
        if chunk_ids:
            self._drop_from_index(user_id, chunk_ids)
        if job is not None and job.duplicate_of is None:
            self._delete_images(artifact_id, job.page_count)
        for dependent in dependents:
            self.store.requeue(dependent.artifact_id)

    def _drop_from_index(self, user_id: str | None, chunk_ids: Sequence[str]) -> None:
        with suppress(ImportError):  # no search extra installed: nothing was ever indexed
            self.indexes().for_user(user_id).delete(chunk_ids)

    def _delete_images(self, artifact_id: str, pages: int) -> None:
        blobs = self._blob_store()
        for page in range(1, pages + 1):
            for variant in ("thumb", "page"):
                blobs.delete(blob_key(artifact_id, page, variant))

    # ------------------------------------------------------------------ the pass

    def process(self, job: Job) -> None:
        """Run the next step(s) of one job. Raises on failure; the worker retries."""
        artifact = self._artifacts.get(job.artifact_id, user_id=job.user_id)
        if artifact is None:
            self.forget(job.artifact_id, job.user_id)
            return
        data = self._artifacts.read(artifact)
        if job.state == STATE_QUEUED:
            job = self._text_pass(job, data)
        if job.state == STATE_TEXT_READY:
            self._finish(job, artifact, data)

    def _text_pass(self, job: Job, data: bytes) -> Job:
        pages, chunk_kind = parse_file(job.kind, data)
        chunks = chunk_pages(pages, kind=chunk_kind)
        rows = self.store.replace_chunks(
            user_id=job.user_id, artifact_id=job.artifact_id, sha=job.sha256, chunks=chunks
        )
        self._index_rows(job, rows)
        updated = self.store.update_job(
            job.artifact_id,
            state=STATE_TEXT_READY,
            page_count=len(pages),
            text_pages=sum(1 for page in pages if page.has_text),
            chunk_count=len(rows),
            last_error=None,
        )
        return updated or job

    def _finish(self, job: Job, artifact: Artifact, data: bytes) -> None:
        rows = self.store.chunks_for(job.artifact_id)
        status, reason = self._embed(job, rows)
        if job.kind == "pdf":
            blobs = self._blob_store()
            for images in render_pages(data):
                blobs.put(blob_key(job.artifact_id, images.page_no, "thumb"), images.thumbnail)
                blobs.put(blob_key(job.artifact_id, images.page_no, "page"), images.page)
        self._index_rows(job, self.store.chunks_for(job.artifact_id))
        self.store.update_job(
            job.artifact_id,
            state=STATE_READY,
            embed_status=status,
            embed_reason=reason,
            last_error=None,
            attempts=0,
        )
        self._supersede_older(artifact)

    def _embed(self, job: Job, rows: list[StoredChunk]) -> tuple[str, str | None]:
        """Embed the passages that have no current vector; ``(status, reason)``."""
        embeddings = self._embeddings()
        if embeddings is None:
            return EMBED_KEYWORD_ONLY, REASON_NO_CONNECTION
        owner = self._owner_key(job.user_id)
        tag = embeddings.tag(owner)
        if tag is None:
            return EMBED_KEYWORD_ONLY, embeddings.available(owner) or REASON_NO_CONNECTION
        todo = [row for row in rows if row.embed_model != tag or not row.embedding]
        if not todo:
            return EMBED_EMBEDDED, None
        try:
            result = embeddings.embed(
                owner, [search_text(row.heading_path, row.text) for row in todo]
            )
        except EmbeddingUnavailable as exc:
            if exc.reason == REASON_ERROR and job.attempts + 1 < MAX_ATTEMPTS:
                raise  # a provider hiccup: retry the job rather than settle for keywords
            return EMBED_KEYWORD_ONLY, exc.reason
        self.store.set_embeddings(
            {
                row.id: (_vector_bytes(vec), result.tag)
                for row, vec in zip(todo, result.vectors, strict=True)
            }
        )
        return EMBED_EMBEDDED, None

    def _supersede_older(self, artifact: Artifact) -> None:
        """Drop the passages of older versions of the same deliverable (the newest wins)."""
        for older in self._artifacts.versions(artifact):
            if older.version < artifact.version:
                self.forget(older.id, older.user_id)

    # ------------------------------------------------------------------ the index

    def _indexed(self, user_id: str | None, rows: Sequence[StoredChunk]) -> list[IndexedChunk]:
        tag = self._current_tag(user_id)
        return [
            IndexedChunk(
                id=row.id,
                text=search_text(row.heading_path, row.text),
                artifact_id=row.artifact_id,
                page_start=row.page_start,
                page_end=row.page_end,
                heading_path=row.heading_path,
                kind=row.kind,
                vector=_from_bytes(row.embedding)
                if row.embedding and row.embed_model == tag
                else None,
            )
            for row in rows
        ]

    def _index_rows(self, job: Job, rows: Sequence[StoredChunk]) -> None:
        """Put one file's passages in its owner's index (a full rebuild when the size changed)."""
        index = self.indexes().for_user(job.user_id)
        dims = self._dims(rows)
        known = index.dims()
        if known is not None and known != dims:
            self.rebuild(job.user_id)
            return
        index.upsert(self._indexed(job.user_id, rows), dims)

    def rebuild(self, user_id: str | None) -> int:
        """Rebuild a person's index from their ``file_chunks`` rows."""
        rows = self.store.chunks_for_owner(user_id)
        return (
            self.indexes()
            .for_user(user_id)
            .rebuild(self._indexed(user_id, rows), self._dims(rows))
        )

    def reindex(self, user_id: str | None) -> int:
        """Send keyword-only files, or ones embedded with an older model, back for embedding."""
        tag = self._current_tag(user_id)
        count = 0
        for job in self.store.jobs_for_owner(user_id):
            if job.duplicate_of or job.state != STATE_READY:
                continue
            stale = job.embed_status != EMBED_EMBEDDED or any(
                row.embed_model != tag for row in self.store.chunks_for(job.artifact_id)
            )
            if stale and tag is not None:
                self.store.update_job(job.artifact_id, state=STATE_TEXT_READY, attempts=0)
                count += 1
        if count:
            self._wake()
        return count

    # ------------------------------------------------------------------ reads

    def status(self, user_id: str | None) -> dict[str, Any]:
        """Index state per file, plus whether this person's searches can use embeddings."""
        embeddings = self._embeddings()
        reason = (
            embeddings.available(self._owner_key(user_id))
            if embeddings is not None
            else REASON_NO_CONNECTION
        )
        return {
            "files": [_job_view(job) for job in self.store.jobs_for_owner(user_id)],
            "embeddings": {"available": reason is None, "reason": reason},
        }

    def search(
        self,
        user_id: str | None,
        query: str,
        *,
        file_ids: Sequence[str] | None = None,
        k: int = DEFAULT_K,
    ) -> dict[str, Any]:
        """Hybrid search over the person's files (BM25 only when they cannot embed)."""
        limit = max(1, min(int(k), MAX_K))
        jobs = {job.artifact_id: job for job in self.store.jobs_for_owner(user_id)}
        source_filter: list[str] | None = None
        if file_ids is not None:
            source_filter = [jobs[i].source_id for i in file_ids if i in jobs]
        mode, reason, query_vector = "keyword", None, None
        embeddings = self._embeddings()
        owner = self._owner_key(user_id)
        if embeddings is None:
            reason = REASON_NO_CONNECTION
        else:
            reason = embeddings.available(owner)
            if reason is None:
                try:
                    query_vector = embeddings.embed(owner, [query]).vectors[0]
                    mode = "hybrid"
                except EmbeddingUnavailable as exc:
                    reason = exc.reason
        hits: list[dict[str, Any]] = []
        if source_filter is None or source_filter:
            hits = (
                self.indexes()
                .for_user(user_id)
                .search(query, limit=limit, artifact_ids=source_filter, query_vector=query_vector)
            )
        chunks = self.store.chunks_by_ids([h["id"] for h in hits])
        names = {job.source_id: job.name for job in jobs.values() if job.duplicate_of is None}
        kinds = {job.source_id: job.kind for job in jobs.values() if job.duplicate_of is None}
        results = []
        for hit in hits:
            chunk = chunks.get(hit["id"])
            if chunk is None:
                continue
            results.append(
                {
                    "file_name": names.get(chunk.artifact_id, ""),
                    "artifact_id": chunk.artifact_id,
                    "page": chunk.page_start,
                    "page_end": chunk.page_end,
                    "score": round(float(hit["score"]), 4),
                    "heading": chunk.heading_path,
                    "passage": chunk.text[:_PASSAGE_CHARS],
                    "thumbnail_url": thumbnail_url(chunk.artifact_id, chunk.page_start)
                    if kinds.get(chunk.artifact_id) == "pdf"
                    else None,
                }
            )
        return {
            "query": query,
            "mode": mode,
            "keyword_only_reason": reason if mode == "keyword" else None,
            "files_indexing": sum(
                1 for j in jobs.values() if j.state in (STATE_QUEUED, STATE_TEXT_READY)
            ),
            "results": results,
        }

    def job_for(self, user_id: str | None, artifact_id: str) -> Job | None:
        """The caller's job for a file, or ``None`` (also for another person's file)."""
        job = self.store.get_job(artifact_id)
        if job is None or job.user_id != user_id:
            return None
        return job

    def page(self, job: Job, page: int) -> dict[str, Any] | None:
        """One page: its text, and its 1024 px image (PDFs only); ``None`` when out of range."""
        if page < 1 or page > max(job.page_count, 1) or job.state == STATE_FAILED:
            return None
        source = job.source_id
        text = "\n".join(c.text for c in self.store.page_chunks(source, page))
        image: bytes | None = None
        if job.kind == "pdf":
            try:
                image = self._blob_store().get(blob_key(source, page, "page"))
            except KeyError:
                image = None
        return {"page": page, "page_count": job.page_count, "text": text, "image": image}

    def page_image(self, job: Job, page: int, variant: str) -> bytes | None:
        """A stored render (``thumb`` or ``page``), or ``None``."""
        if job.kind != "pdf" or page < 1 or page > job.page_count:
            return None
        try:
            return self._blob_store().get(blob_key(job.source_id, page, variant))
        except KeyError:
            return None

    # ------------------------------------------------------------------ failures

    def record_failure(self, job: Job, error: Exception) -> None:
        """Count a failed attempt: retry later with a growing delay, then give up."""
        attempts = job.attempts + 1
        message = (str(error) or type(error).__name__)[:300]
        if attempts >= MAX_ATTEMPTS:
            self.store.update_job(
                job.artifact_id, state=STATE_FAILED, attempts=attempts, last_error=message
            )
            return
        self.store.update_job(
            job.artifact_id,
            attempts=attempts,
            last_error=message,
            next_attempt_at=now_epoch() + _BACKOFF_SECONDS * 4 ** (attempts - 1),
        )


def thumbnail_url(artifact_id: str, page: int) -> str:
    """The engine path of a page thumbnail (the owner's session only)."""
    return f"/v1/knowledge/files/{artifact_id}/pages/{page}/thumbnail"


def _job_view(job: Job) -> dict[str, Any]:
    state = (
        "failed"
        if job.state == STATE_FAILED
        else "searchable"
        if job.state == STATE_READY
        else "indexing"
    )
    return {
        "artifact_id": job.artifact_id,
        "name": job.name,
        "kind": job.kind,
        "state": state,
        "stage": job.state,
        "search": "hybrid" if job.embed_status == EMBED_EMBEDDED else "keyword",
        "keyword_only_reason": job.embed_reason,
        "duplicate_of": job.duplicate_of,
        "pages": job.page_count,
        "pages_without_text": max(job.page_count - job.text_pages, 0) if job.kind == "pdf" else 0,
        "chunks": job.chunk_count,
        "error": job.last_error if job.state == STATE_FAILED else None,
    }
