"""The Computer's indexer: keep the index in step with the files area, and answer from it.

The files area is ``your_files/`` and each Goal's ``files/`` under the workspace (uploads, what the
Muse saves, what it writes there). :meth:`Indexer.scan` is the reconcile: new or changed files are
queued, vanished ones are dropped; :meth:`Indexer.add` is the event path for one file (an upload, a
saved artifact). :meth:`Indexer.process_next` runs one file through its passes:

``queued -> text_ready``: parse, cut into passages with page numbers, store them (keyword-
searchable at once).
``text_ready -> ready``: embed the passages through the model proxy (keyword-only, with the reason,
when the owner has no embedding connection), render PDF page thumbnails, settle.

Everything blocks; the runtime (:mod:`omnigent.runner.knowledge.runtime`) runs it in one thread.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path, PurePosixPath
from typing import Any

from omnigent.runner.knowledge.chunking import chunk_pages
from omnigent.runner.knowledge.db import (
    EMBED_EMBEDDED,
    EMBED_KEYWORD,
    STATE_FAILED,
    STATE_QUEUED,
    STATE_READY,
    STATE_TEXT_READY,
    ChunkRow,
    FileRow,
    KnowledgeDb,
    file_id_for,
    search_text,
)
from omnigent.runner.knowledge.embedder import (
    REASON_ERROR,
    REASON_NO_CONNECTION,
    Embedder,
    EmbeddingUnavailable,
)
from omnigent.runner.knowledge.parse import INDEXABLE_KINDS, parse_file
from omnigent.runner.knowledge.pdf import render_page, render_thumbnails

_logger = logging.getLogger(__name__)

#: A file larger than this is not indexed (it shows as failed, with the reason).
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ATTEMPTS = 3
_BACKOFF_SECONDS = 30
DEFAULT_K = 8
MAX_K = 25
#: Longest passage returned to the model, in characters.
_PASSAGE_CHARS = 1600
#: Kinds by file extension (lower case, with the dot).
_EXTENSION_KIND = {
    ".pdf": "pdf",
    ".txt": "txt",
    ".md": "md",
    ".markdown": "md",
    ".csv": "csv",
    ".xlsx": "xlsx",
}
_SKIPPED_DIRS = frozenset({"node_modules", "__pycache__"})


def kind_of(name: str) -> str | None:
    """The indexable kind of a file name, or ``None`` when it is not one we read."""
    kind = _EXTENSION_KIND.get(PurePosixPath(name).suffix.lower())
    return kind if kind in INDEXABLE_KINDS else None


def thumbnail_ref(file_id: str, page: int) -> str:
    """The relative reference a search hit carries for a page thumbnail."""
    return f"files/{file_id}/pages/{page}/thumbnail"


class AmbiguousFile(Exception):
    """A plain file name that matches more than one indexed file."""

    def __init__(self, ref: str, candidates: list[str]) -> None:
        super().__init__(ref)
        self.ref = ref
        self.candidates = candidates


class Indexer:
    """Indexes the files area of one workspace; see the module docstring."""

    def __init__(
        self,
        home: Path,
        workspace: Path,
        embedder: Embedder,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        """
        :param home: The index directory (``~/.nova/knowledge``): the database and thumbnails.
        :param workspace: The workspace root the indexed paths are relative to (``~/workspace``).
        :param embedder: Makes the vectors (or says why it cannot).
        """
        self.db = KnowledgeDb(home)
        self.workspace = workspace
        self.embedder = embedder
        self._thumbs = Path(home) / "thumbs"
        self._clock = clock

    # ------------------------------------------------------------------ the files area

    def _areas(self) -> Iterator[Path]:
        yield self.workspace / "your_files"
        goals = self.workspace / "goals"
        try:
            for goal in sorted(goals.iterdir()):
                yield goal / "files"
        except OSError:
            return

    def _walk(self) -> Iterator[tuple[str, Path]]:
        """``(relative path, absolute path)`` of every indexable file in the files area."""
        for area in self._areas():
            for directory, dirs, names in os.walk(area):
                dirs[:] = sorted(
                    d for d in dirs if not d.startswith(".") and d not in _SKIPPED_DIRS
                )
                for name in sorted(names):
                    if name.startswith(".") or kind_of(name) is None:
                        continue
                    absolute = Path(directory) / name
                    try:
                        relative = absolute.relative_to(self.workspace).as_posix()
                    except ValueError:
                        continue
                    yield relative, absolute

    def relative(self, path: str | Path) -> str | None:
        """*path* (absolute or workspace-relative) as a workspace-relative POSIX path, or ``None``
        when it lies outside the workspace."""
        given = Path(path)
        absolute = given if given.is_absolute() else self.workspace / given
        try:
            return absolute.resolve().relative_to(self.workspace.resolve()).as_posix()
        except (ValueError, OSError):
            return None

    def absolute(self, relative: str) -> Path:
        """The file's absolute path."""
        return self.workspace / relative

    def scan(self) -> dict[str, int]:
        """Reconcile the index with the disk: queue new and changed files, drop vanished ones.

        :returns: Counts ``{"added", "changed", "removed"}``.
        """
        counts = {"added": 0, "changed": 0, "removed": 0}
        known = {row.path: row for row in self.db.files()}
        seen: set[str] = set()
        for relative, absolute in self._walk():
            seen.add(relative)
            outcome = self._sync(relative, absolute, known.get(relative), explicit=False)
            if outcome:
                counts[outcome] += 1
        for relative, row in known.items():
            if relative in seen:
                continue
            absolute = self.absolute(relative)
            if row.explicit and absolute.is_file():
                if self._sync(relative, absolute, row, explicit=True) == "changed":
                    counts["changed"] += 1
                continue
            self.remove(relative)
            counts["removed"] += 1
        return counts

    def add(self, path: str | Path, *, explicit: bool = False) -> bool:
        """Queue one file now (an upload or a saved artifact). ``False`` when it is not indexable.

        :param explicit: Keep it indexed even outside the files area (a saved artifact).
        """
        relative = self.relative(path)
        if relative is None or kind_of(relative) is None:
            return False
        absolute = self.absolute(relative)
        if not absolute.is_file():
            return False
        self._sync(relative, absolute, self.db.file_by_path(relative), explicit=explicit)
        return True

    def remove(self, path: str | Path) -> None:
        """Forget a file and its thumbnails."""
        relative = self.relative(path) or str(path)
        fid = file_id_for(relative)
        self.db.delete_file(fid)
        self._drop_thumbs(fid)

    def _sync(
        self, relative: str, absolute: Path, row: FileRow | None, *, explicit: bool
    ) -> str | None:
        try:
            stat = absolute.stat()
        except OSError:
            return None
        unchanged = (
            row is not None and row.size == stat.st_size and row.mtime_ns == stat.st_mtime_ns
        )
        if unchanged:
            if explicit and not row.explicit:
                self.db.update_file(row.file_id, explicit=1)
            return None
        kind = kind_of(relative)
        assert kind is not None
        self._drop_thumbs(file_id_for(relative))
        queued = self.db.upsert_file(
            path=relative,
            name=PurePosixPath(relative).name,
            kind=kind,
            size=stat.st_size,
            mtime_ns=stat.st_mtime_ns,
            explicit=explicit,
        )
        if stat.st_size > MAX_FILE_BYTES:
            self.db.update_file(
                queued.file_id,
                state=STATE_FAILED,
                last_error=f"File is too large to search ({MAX_FILE_BYTES >> 20} MB max)",
            )
        return "added" if row is None else "changed"

    # ------------------------------------------------------------------ the pass

    def process_next(self) -> bool:
        """Run the next due file one step further. ``False`` when nothing is due."""
        row = self.db.next_due(self._clock())
        if row is None:
            return False
        try:
            self.process(row)
        except Exception as exc:  # noqa: BLE001 - a bad file must not stop the indexer
            _logger.warning("indexing %s failed (%s)", row.path, type(exc).__name__)
            self._record_failure(row, exc)
        return True

    def process(self, row: FileRow) -> None:
        """Run the pass(es) a file is due. Raises on failure; the caller records it."""
        absolute = self.absolute(row.path)
        if not absolute.is_file():
            self.remove(row.path)
            return
        data = absolute.read_bytes()
        if row.state == STATE_QUEUED:
            row = self._text_pass(row, data)
        if row.state == STATE_TEXT_READY:
            self._finish(row, data)

    def _text_pass(self, row: FileRow, data: bytes) -> FileRow:
        pages, chunk_kind = parse_file(row.kind, data)
        chunks = chunk_pages(pages, kind=chunk_kind)
        stored = self.db.replace_chunks(row.file_id, chunks)
        self.db.update_file(
            row.file_id,
            state=STATE_TEXT_READY,
            page_count=len(pages),
            text_pages=sum(1 for page in pages if page.has_text),
            chunk_count=len(stored),
            last_error=None,
        )
        updated = self.db.get_file(row.file_id)
        assert updated is not None
        return updated

    def _finish(self, row: FileRow, data: bytes) -> None:
        status, reason = self._embed(row, self.db.chunks_for(row.file_id))
        if row.kind == "pdf":
            self._write_thumbs(row.file_id, data)
        self.db.update_file(
            row.file_id,
            state=STATE_READY,
            embed_status=status,
            embed_reason=reason,
            last_error=None,
            attempts=0,
        )

    def _embed(self, row: FileRow, chunks: Sequence[ChunkRow]) -> tuple[str, str | None]:
        """Embed the passages that have no current vector; ``(status, reason)``."""
        if not chunks:
            return EMBED_KEYWORD, None
        try:
            plan = self.embedder.plan()
        except EmbeddingUnavailable as exc:
            return EMBED_KEYWORD, exc.reason
        todo = [c for c in chunks if c.embed_tag != plan.tag]
        if not todo:
            return EMBED_EMBEDDED, None
        try:
            result = self.embedder.embed([search_text(c.heading_path, c.text) for c in todo])
        except EmbeddingUnavailable as exc:
            if exc.reason == REASON_ERROR and row.attempts + 1 < MAX_ATTEMPTS:
                raise  # a provider hiccup: retry the file rather than settle for keywords
            return EMBED_KEYWORD, exc.reason
        dims = len(result.vectors[0])
        stored = self.db.set_vectors(
            {c.id: v for c, v in zip(todo, result.vectors, strict=True)}, result.tag, dims
        )
        if not stored:
            return EMBED_KEYWORD, REASON_NO_CONNECTION
        return EMBED_EMBEDDED, None

    def _record_failure(self, row: FileRow, error: Exception) -> None:
        """Count a failed attempt: retry later with a growing delay, then give up."""
        attempts = row.attempts + 1
        message = (str(error) or type(error).__name__)[:300]
        if attempts >= MAX_ATTEMPTS:
            self.db.update_file(
                row.file_id, state=STATE_FAILED, attempts=attempts, last_error=message
            )
            return
        self.db.update_file(
            row.file_id,
            attempts=attempts,
            last_error=message,
            next_attempt_at=self._clock() + _BACKOFF_SECONDS * 4 ** (attempts - 1),
        )

    def reindex(self) -> int:
        """Send files that are keyword-only or embedded with another model back for embedding."""
        try:
            tag = self.embedder.plan().tag
        except EmbeddingUnavailable:
            return 0
        count = 0
        for row in self.db.files():
            if row.state != STATE_READY or not row.chunk_count:
                continue
            stale = row.embed_status != EMBED_EMBEDDED or any(
                c.embed_tag != tag for c in self.db.chunks_for(row.file_id)
            )
            if stale:
                self.db.update_file(row.file_id, state=STATE_TEXT_READY, attempts=0)
                count += 1
        return count

    def maybe_reindex(self) -> int:
        """Re-embed once when the embedding model changes (a key was added, or the model moved).

        Files that failed to embed are not retried here until the model tag changes again.
        """
        try:
            tag = self.embedder.plan().tag
        except EmbeddingUnavailable:
            return 0
        if self.db.meta("reindexed_tag") == tag:
            return 0
        count = self.reindex()
        self.db.set_meta("reindexed_tag", tag)
        return count

    # ------------------------------------------------------------------ thumbnails

    def _thumb_path(self, file_id: str, page: int) -> Path:
        return self._thumbs / file_id / f"{page:05d}.webp"

    def _write_thumbs(self, file_id: str, data: bytes) -> None:
        directory = self._thumbs / file_id
        directory.mkdir(parents=True, exist_ok=True)
        for page, webp in render_thumbnails(data):
            self._thumb_path(file_id, page).write_bytes(webp)

    def _drop_thumbs(self, file_id: str) -> None:
        directory = self._thumbs / file_id
        if not directory.is_dir():
            return
        for child in directory.iterdir():
            child.unlink(missing_ok=True)
        directory.rmdir()

    def thumbnail(self, file_id: str, page: int) -> bytes | None:
        """A page's stored 256 px WebP, or ``None``."""
        row = self.db.get_file(file_id)
        if row is None or row.kind != "pdf" or page < 1 or page > row.page_count:
            return None
        try:
            return self._thumb_path(file_id, page).read_bytes()
        except OSError:
            return None

    # ------------------------------------------------------------------ reads

    def status(self) -> dict[str, Any]:
        """Index state per file, and whether searches can use embeddings."""
        reason: str | None = None
        try:
            self.embedder.plan()
        except EmbeddingUnavailable as exc:
            reason = exc.reason
        return {
            "files": [
                {**_file_view(row), "abs_path": str(self.absolute(row.path))}
                for row in self.db.files()
            ],
            "embeddings": {"available": reason is None, "reason": reason},
            "pending": self.db.pending_count(),
        }

    def search(
        self, query: str, *, file_ids: Sequence[str] | None = None, k: int = DEFAULT_K
    ) -> dict[str, Any]:
        """Hybrid search over the files (BM25 only when the owner cannot embed)."""
        limit = max(1, min(int(k), MAX_K))
        mode, reason, vector = "keyword", None, None
        try:
            vector = self.embedder.embed([query]).vectors[0]
            mode = "hybrid"
        except EmbeddingUnavailable as exc:
            reason = exc.reason
        files = {row.file_id: row for row in self.db.files()}
        found = self.db.search(query, limit=limit, file_ids=file_ids, query_vector=vector)
        results = []
        for chunk, score in found:
            row = files.get(chunk.file_id)
            if row is None:
                continue
            results.append(
                {
                    "file_id": row.file_id,
                    "path": row.path,
                    "abs_path": str(self.absolute(row.path)),
                    "file_name": row.name,
                    "page": chunk.page_start,
                    "page_end": chunk.page_end,
                    "score": round(score, 4),
                    "heading": chunk.heading_path,
                    "passage": chunk.text[:_PASSAGE_CHARS],
                    "thumbnail_url": thumbnail_ref(row.file_id, chunk.page_start)
                    if row.kind == "pdf"
                    and self._thumb_path(row.file_id, chunk.page_start).exists()
                    else None,
                }
            )
        return {
            "query": query,
            "mode": mode,
            "keyword_only_reason": reason if mode == "keyword" else None,
            "files_indexing": self.db.pending_count(),
            "results": results,
        }

    def resolve(self, file_id: str | None, path: str | None) -> FileRow | None:
        """The file named by id, or by workspace path or plain file name (either may be given).

        :raises AmbiguousFile: when a plain name matches several files.
        """
        if file_id:
            return self.db.get_file(file_id)
        ref = (path or "").strip()
        if not ref:
            return None
        relative = self.relative(ref)
        row = self.db.file_by_path(relative) if relative else None
        if row is not None:
            return row
        wanted = ref.replace("\\", "/").strip("/").lower()
        matches = [
            f
            for f in self.db.files()
            if f.path.lower() == wanted
            or f.path.lower().endswith("/" + wanted)
            or f.name.lower() == wanted
        ]
        if len(matches) > 1:
            raise AmbiguousFile(ref, [m.path for m in matches])
        return matches[0] if matches else None

    def page(self, row: FileRow, page: int) -> dict[str, Any] | None:
        """One page: its text and, for a PDF, its 1024 px image; ``None`` when out of range."""
        if page < 1 or page > max(row.page_count, 1) or row.state == STATE_FAILED:
            return None
        text = "\n".join(c.text for c in self.db.page_chunks(row.file_id, page))
        image: bytes | None = None
        if row.kind == "pdf":
            try:
                image = render_page(self.absolute(row.path).read_bytes(), page)
            except OSError:
                image = None
        return {
            "file_id": row.file_id,
            "path": row.path,
            "name": row.name,
            "page": page,
            "page_count": row.page_count,
            "text": text,
            "image_base64": base64.b64encode(image).decode() if image else None,
            "image_mime": "image/webp" if image else None,
        }


def _file_view(row: FileRow) -> dict[str, Any]:
    state = (
        "failed"
        if row.state == STATE_FAILED
        else "searchable"
        if row.state == STATE_READY
        else "indexing"
    )
    return {
        "file_id": row.file_id,
        "path": row.path,
        "name": row.name,
        "kind": row.kind,
        "state": state,
        "search": "hybrid" if row.embed_status == EMBED_EMBEDDED else "keyword",
        "keyword_only_reason": row.embed_reason,
        "pages": row.page_count,
        "pages_without_text": max(row.page_count - row.text_pages, 0) if row.kind == "pdf" else 0,
        "chunks": row.chunk_count,
        "error": row.last_error if row.state == STATE_FAILED else None,
    }
