"""Knowledge store: index jobs and the passages (``file_chunks``) the search index is built from.

Everything is scoped by owner (``user_id``; ``None`` in single-user mode). A job walks
``queued -> text_ready -> ready`` or ends ``failed``; a file whose bytes another file of the same
person already has points at that file (``duplicate_of``) and holds no passages of its own.
"""

from __future__ import annotations

import uuid
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlFileChunk, SqlFileIndexJob, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.superchat.knowledge.chunking import Chunk

STATE_QUEUED = "queued"
STATE_TEXT_READY = "text_ready"
STATE_READY = "ready"
STATE_FAILED = "failed"
#: States the worker still has work for.
PENDING_STATES = (STATE_QUEUED, STATE_TEXT_READY)

EMBED_PENDING = "pending"
EMBED_EMBEDDED = "embedded"
EMBED_KEYWORD_ONLY = "keyword_only"


@dataclass(frozen=True)
class Job:
    """One file's index job."""

    artifact_id: str
    user_id: str | None
    name: str
    kind: str
    sha256: str
    state: str
    attempts: int
    last_error: str | None
    page_count: int
    text_pages: int
    chunk_count: int
    embed_status: str
    embed_reason: str | None
    duplicate_of: str | None
    created_at: int
    updated_at: int
    next_attempt_at: int

    @property
    def source_id(self) -> str:
        """The artifact that holds this file's passages and page images."""
        return self.duplicate_of or self.artifact_id


@dataclass(frozen=True)
class StoredChunk:
    """One passage row."""

    id: str
    user_id: str | None
    artifact_id: str
    sha: str
    ord: int
    page_start: int
    page_end: int
    kind: str
    heading_path: str
    text: str
    embedding: bytes | None
    embed_model: str | None


def _job(row: SqlFileIndexJob) -> Job:
    return Job(
        artifact_id=row.artifact_id,
        user_id=row.user_id,
        name=row.name,
        kind=row.kind,
        sha256=row.sha256,
        state=row.state,
        attempts=row.attempts,
        last_error=row.last_error,
        page_count=row.page_count,
        text_pages=row.text_pages,
        chunk_count=row.chunk_count,
        embed_status=row.embed_status,
        embed_reason=row.embed_reason,
        duplicate_of=row.duplicate_of,
        created_at=row.created_at,
        updated_at=row.updated_at,
        next_attempt_at=row.next_attempt_at,
    )


def _chunk(row: SqlFileChunk) -> StoredChunk:
    return StoredChunk(
        id=row.id,
        user_id=row.user_id,
        artifact_id=row.artifact_id,
        sha=row.sha,
        ord=row.ord,
        page_start=row.page_start,
        page_end=row.page_end,
        kind=row.kind,
        heading_path=row.heading_path,
        text=row.text,
        embedding=row.embedding,
        embed_model=row.embed_model,
    )


def _owner(column: Any, user_id: str | None) -> Any:
    return column.is_(None) if user_id is None else column == user_id


class KnowledgeStore:
    """SQLAlchemy-backed store of index jobs and passages."""

    def __init__(self, storage_location: str) -> None:
        """:param storage_location: SQLAlchemy database URI."""
        self.storage_location = storage_location
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.knowledge_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.knowledge_store", immediate=True
        )

    # ------------------------------------------------------------------ jobs

    def enqueue(
        self,
        *,
        user_id: str | None,
        artifact_id: str,
        name: str,
        kind: str,
        sha256: str,
        same_group: Collection[str] = (),
    ) -> Job:
        """Queue a file for indexing (idempotent per artifact version).

        A file whose bytes (sha256) another file of the same person already has is not indexed
        again: it is marked ``ready`` and points at that file. Other versions of the same
        deliverable (*same_group*) do not count as duplicates, so a revert is indexed afresh.
        """
        now = now_epoch()

        def write(session: Session) -> Job:
            ws = current_workspace_id()
            existing = session.get(SqlFileIndexJob, (ws, artifact_id))
            if existing is not None:
                return _job(existing)
            query = select(SqlFileIndexJob).where(
                SqlFileIndexJob.workspace_id == ws,
                _owner(SqlFileIndexJob.user_id, user_id),
                SqlFileIndexJob.sha256 == sha256,
                SqlFileIndexJob.artifact_id != artifact_id,
                SqlFileIndexJob.duplicate_of.is_(None),
                SqlFileIndexJob.state.in_((*PENDING_STATES, STATE_READY)),
            )
            if same_group:
                query = query.where(SqlFileIndexJob.artifact_id.not_in(list(same_group)))
            twin = session.scalars(query.order_by(SqlFileIndexJob.created_at).limit(1)).first()
            row = SqlFileIndexJob(
                artifact_id=artifact_id,
                user_id=user_id,
                name=name,
                kind=kind,
                sha256=sha256,
                state=STATE_READY if twin else STATE_QUEUED,
                attempts=0,
                page_count=twin.page_count if twin else 0,
                text_pages=twin.text_pages if twin else 0,
                chunk_count=0,
                embed_status=twin.embed_status if twin else EMBED_PENDING,
                embed_reason=twin.embed_reason if twin else None,
                duplicate_of=twin.artifact_id if twin else None,
                created_at=now,
                updated_at=now,
                next_attempt_at=0,
            )
            session.add(row)
            session.flush()
            return _job(row)

        return run_write_transaction(self._session_immediate, "enqueue_file_index_job", write)

    def get_job(self, artifact_id: str) -> Job | None:
        """The job of one artifact version, or ``None``."""
        with self._session("select_file_index_job") as session:
            row = session.get(SqlFileIndexJob, (current_workspace_id(), artifact_id))
            return _job(row) if row is not None else None

    def jobs_for_owner(self, user_id: str | None) -> list[Job]:
        """Every job of the person, newest first."""
        with self._session("list_file_index_jobs") as session:
            rows = session.scalars(
                select(SqlFileIndexJob)
                .where(
                    SqlFileIndexJob.workspace_id == current_workspace_id(),
                    _owner(SqlFileIndexJob.user_id, user_id),
                )
                .order_by(SqlFileIndexJob.created_at.desc())
            ).all()
            return [_job(r) for r in rows]

    def jobs_by_ids(self, artifact_ids: Iterable[str]) -> list[Job]:
        """The jobs of these artifact versions (those that have one)."""
        ids = list(artifact_ids)
        if not ids:
            return []
        with self._session("list_file_index_jobs_by_id") as session:
            rows = session.scalars(
                select(SqlFileIndexJob).where(
                    SqlFileIndexJob.workspace_id == current_workspace_id(),
                    SqlFileIndexJob.artifact_id.in_(ids),
                )
            ).all()
            return [_job(r) for r in rows]

    def dependents(self, artifact_id: str) -> list[Job]:
        """Jobs that point at *artifact_id* as their duplicate source."""
        with self._session("list_file_index_dependents") as session:
            rows = session.scalars(
                select(SqlFileIndexJob).where(
                    SqlFileIndexJob.workspace_id == current_workspace_id(),
                    SqlFileIndexJob.duplicate_of == artifact_id,
                )
            ).all()
            return [_job(r) for r in rows]

    def next_due(self, now: int | None = None) -> Job | None:
        """The oldest pending job whose retry time has come, or ``None``."""
        at = now if now is not None else now_epoch()
        with self._session("select_next_file_index_job") as session:
            row = session.scalars(
                select(SqlFileIndexJob)
                .where(
                    SqlFileIndexJob.workspace_id == current_workspace_id(),
                    SqlFileIndexJob.state.in_(PENDING_STATES),
                    SqlFileIndexJob.next_attempt_at <= at,
                )
                .order_by(SqlFileIndexJob.created_at)
                .limit(1)
            ).first()
            return _job(row) if row is not None else None

    def next_retry_at(self) -> int | None:
        """When the earliest waiting pending job is due (for the worker's sleep), or ``None``."""
        with self._session("select_next_file_index_retry") as session:
            return session.scalar(
                select(func.min(SqlFileIndexJob.next_attempt_at)).where(
                    SqlFileIndexJob.workspace_id == current_workspace_id(),
                    SqlFileIndexJob.state.in_(PENDING_STATES),
                )
            )

    def update_job(self, artifact_id: str, **fields: Any) -> Job | None:
        """Set columns on a job (and its ``updated_at``); ``None`` when it is gone."""

        def write(session: Session) -> Job | None:
            row = session.get(SqlFileIndexJob, (current_workspace_id(), artifact_id))
            if row is None:
                return None
            for key, value in fields.items():
                setattr(row, key, value)
            row.updated_at = now_epoch()
            session.flush()
            return _job(row)

        return run_write_transaction(self._session_immediate, "update_file_index_job", write)

    def requeue(self, artifact_id: str) -> None:
        """Send a job back to ``queued`` with no duplicate source (its source was removed)."""
        self.update_job(
            artifact_id,
            state=STATE_QUEUED,
            duplicate_of=None,
            attempts=0,
            last_error=None,
            next_attempt_at=0,
            embed_status=EMBED_PENDING,
            embed_reason=None,
        )

    # ------------------------------------------------------------------ chunks

    def replace_chunks(
        self,
        *,
        user_id: str | None,
        artifact_id: str,
        sha: str,
        chunks: Sequence[Chunk],
    ) -> list[StoredChunk]:
        """Store the passages of a file, replacing any it had; returns the new rows."""

        def write(session: Session) -> list[StoredChunk]:
            ws = current_workspace_id()
            session.execute(
                delete(SqlFileChunk).where(
                    SqlFileChunk.workspace_id == ws, SqlFileChunk.artifact_id == artifact_id
                )
            )
            rows = [
                SqlFileChunk(
                    id=uuid.uuid4().hex,
                    user_id=user_id,
                    artifact_id=artifact_id,
                    sha=sha,
                    ord=index,
                    page_start=chunk.page_start,
                    page_end=chunk.page_end,
                    kind=chunk.kind,
                    heading_path=chunk.heading_path,
                    text=chunk.text,
                    embedding=None,
                    embed_model=None,
                )
                for index, chunk in enumerate(chunks)
            ]
            session.add_all(rows)
            session.flush()
            return [_chunk(r) for r in rows]

        return run_write_transaction(self._session_immediate, "replace_file_chunks", write)

    def chunks_for(self, artifact_id: str) -> list[StoredChunk]:
        """The passages of one file, in reading order."""
        with self._session("list_file_chunks") as session:
            rows = session.scalars(
                select(SqlFileChunk)
                .where(
                    SqlFileChunk.workspace_id == current_workspace_id(),
                    SqlFileChunk.artifact_id == artifact_id,
                )
                .order_by(SqlFileChunk.ord)
            ).all()
            return [_chunk(r) for r in rows]

    def chunks_for_owner(self, user_id: str | None) -> list[StoredChunk]:
        """Every passage of the person (what the search index is rebuilt from)."""
        with self._session("list_owner_file_chunks") as session:
            rows = session.scalars(
                select(SqlFileChunk)
                .where(
                    SqlFileChunk.workspace_id == current_workspace_id(),
                    _owner(SqlFileChunk.user_id, user_id),
                )
                .order_by(SqlFileChunk.artifact_id, SqlFileChunk.ord)
            ).all()
            return [_chunk(r) for r in rows]

    def set_embeddings(self, vectors: dict[str, tuple[bytes, str]]) -> None:
        """Store ``chunk id -> (vector bytes, model tag)``."""
        if not vectors:
            return

        def write(session: Session) -> None:
            ws = current_workspace_id()
            for chunk_id, (blob, model) in vectors.items():
                session.execute(
                    update(SqlFileChunk)
                    .where(SqlFileChunk.workspace_id == ws, SqlFileChunk.id == chunk_id)
                    .values(embedding=blob, embed_model=model)
                )

        run_write_transaction(self._session_immediate, "set_file_chunk_embeddings", write)

    def chunks_by_ids(self, chunk_ids: Iterable[str]) -> dict[str, StoredChunk]:
        """The passages with these ids."""
        ids = list(chunk_ids)
        if not ids:
            return {}
        with self._session("list_file_chunks_by_id") as session:
            rows = session.scalars(
                select(SqlFileChunk).where(
                    SqlFileChunk.workspace_id == current_workspace_id(),
                    SqlFileChunk.id.in_(ids),
                )
            ).all()
            return {r.id: _chunk(r) for r in rows}

    def page_chunks(self, artifact_id: str, page: int) -> list[StoredChunk]:
        """The passages that start on *page*, in order (their text is the page's text)."""
        with self._session("list_file_page_chunks") as session:
            rows = session.scalars(
                select(SqlFileChunk)
                .where(
                    SqlFileChunk.workspace_id == current_workspace_id(),
                    SqlFileChunk.artifact_id == artifact_id,
                    SqlFileChunk.page_start == page,
                )
                .order_by(SqlFileChunk.ord)
            ).all()
            return [_chunk(r) for r in rows]

    def remove_artifact(self, artifact_id: str) -> tuple[list[str], Job | None]:
        """Delete a file's job and passages; returns the passage ids and the job it had."""

        def write(session: Session) -> tuple[list[str], Job | None]:
            ws = current_workspace_id()
            ids = list(
                session.scalars(
                    select(SqlFileChunk.id).where(
                        SqlFileChunk.workspace_id == ws, SqlFileChunk.artifact_id == artifact_id
                    )
                )
            )
            session.execute(
                delete(SqlFileChunk).where(
                    SqlFileChunk.workspace_id == ws, SqlFileChunk.artifact_id == artifact_id
                )
            )
            row = session.get(SqlFileIndexJob, (ws, artifact_id))
            job = _job(row) if row is not None else None
            if row is not None:
                session.delete(row)
            return ids, job

        return run_write_transaction(self._session_immediate, "remove_file_index", write)
