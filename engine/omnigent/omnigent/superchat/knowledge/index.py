"""Per-user txtai hybrid index (BM25 + dense) over ``file_chunks``.

The table is the source of truth; the index is a rebuildable projection of it, kept in step per
file (``upsert`` / ``delete``) and rebuilt in full from the table (``rebuild``), like
:class:`omnigent.memory.index.MemoryIndex`. Vectors are stored ones, served through the
``external`` method (see :mod:`omnigent.superchat.knowledge.vectors`), so txtai never calls a
provider.

``txtai`` is imported lazily: building an index needs the optional ``omnigent[memory]`` extra.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from omnigent.superchat.knowledge.vectors import TRANSFORM_PATH, provide

# Pure-numpy ANN backend, as the memory index: no faiss on the query path, and a person's corpus
# is small enough for an exact scan.
_ANN_BACKEND = "numpy"
_META = "knowledge.json"
_HEX_ID = re.compile(r"^[0-9a-f]{32}$")
_MIN_CANDIDATES = 200


def missing_extra_error() -> ImportError:
    """The error raised when txtai is not installed."""
    return ImportError(
        "File search needs the 'memory' extra: install with `uv sync --extra memory`."
    )


@dataclass(frozen=True)
class IndexedChunk:
    """One passage as the index holds it.

    :param vector: The stored embedding, or ``None`` for a keyword-only chunk.
    """

    id: str
    text: str
    artifact_id: str
    page_start: int
    page_end: int
    heading_path: str
    kind: str
    vector: Sequence[float] | None = None


def user_dir_name(user_id: str | None) -> str:
    """A filesystem-safe directory name for a person's index."""
    return hashlib.sha256((user_id or "local").encode()).hexdigest()[:24]


class UserIndex:
    """One person's index, persisted under *path* (txtai owns the files inside it)."""

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._embeddings: Any | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ state

    def dims(self) -> int | None:
        """The vector size the saved index was built with, or ``None`` when there is none."""
        try:
            return int(json.loads((self._path / _META).read_text())["dims"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _write_meta(self, dims: int) -> None:
        self._path.mkdir(parents=True, exist_ok=True)
        (self._path / _META).write_text(json.dumps({"dims": dims}))

    def _new(self) -> Any:
        try:
            from txtai.embeddings import Embeddings
        except ImportError as exc:
            raise missing_extra_error() from exc
        return Embeddings(
            content=True,
            hybrid=True,
            backend=_ANN_BACKEND,
            method="external",
            transform=TRANSFORM_PATH,
        )

    def _loaded(self) -> Any:
        if self._embeddings is not None:
            return self._embeddings
        if self.dims() is None:
            self._embeddings = self._new()
            return self._embeddings
        embeddings = self._new()
        embeddings.load(str(self._path))
        self._embeddings = embeddings
        return embeddings

    @staticmethod
    def _documents(chunks: Sequence[IndexedChunk]) -> list[tuple[str, dict[str, Any], None]]:
        return [
            (
                c.id,
                {
                    "text": c.text,
                    "artifact_id": c.artifact_id,
                    "page_start": c.page_start,
                    "page_end": c.page_end,
                    "heading_path": c.heading_path,
                    "kind": c.kind,
                },
                None,
            )
            for c in chunks
        ]

    @staticmethod
    def _vectors(chunks: Sequence[IndexedChunk]) -> dict[str, Sequence[float]]:
        return {c.text: c.vector for c in chunks if c.vector is not None}

    # ------------------------------------------------------------------ writes

    def upsert(self, chunks: Sequence[IndexedChunk], dims: int) -> None:
        """Index (or re-index) *chunks*; the caller rebuilds first when *dims* changed."""
        if not chunks:
            return
        with self._lock, provide(self._vectors(chunks), dims):
            embeddings = self._loaded()
            embeddings.upsert(self._documents(chunks))
            self._path.mkdir(parents=True, exist_ok=True)
            embeddings.save(str(self._path))
            self._write_meta(dims)

    def delete(self, chunk_ids: Sequence[str]) -> None:
        """Remove chunks (a deleted or superseded file)."""
        if not chunk_ids or self.dims() is None:
            return
        with self._lock:
            embeddings = self._loaded()
            embeddings.delete(list(chunk_ids))
            embeddings.save(str(self._path))

    def rebuild(self, chunks: Sequence[IndexedChunk], dims: int) -> int:
        """Rebuild the whole index from *chunks* (the person's rows of ``file_chunks``)."""
        with self._lock:
            if not chunks:
                self._embeddings = None
                self._drop()
                return 0
            embeddings = self._new()
            with provide(self._vectors(chunks), dims):
                embeddings.index(self._documents(chunks))
            self._path.mkdir(parents=True, exist_ok=True)
            embeddings.save(str(self._path))
            self._write_meta(dims)
            self._embeddings = embeddings
            return len(chunks)

    def _drop(self) -> None:
        if not self._path.is_dir():
            return
        for child in self._path.iterdir():
            if child.is_file():
                child.unlink()
            else:
                import shutil

                shutil.rmtree(child, ignore_errors=True)

    # ------------------------------------------------------------------ reads

    def search(
        self,
        query: str,
        *,
        limit: int,
        artifact_ids: Sequence[str] | None = None,
        query_vector: Sequence[float] | None = None,
    ) -> list[dict[str, Any]]:
        """Hybrid search; keyword-only (BM25) when *query_vector* is ``None``.

        :param artifact_ids: Restrict to these files (32-char hex ids).
        :returns: Rows with ``id``, ``text``, ``score``, ``artifact_id``, ``page_start``,
            ``page_end``, ``heading_path`` and ``kind``, best first.
        """
        dims = self.dims()
        if dims is None:
            return []
        candidates = max(limit * 10, _MIN_CANDIDATES)
        sql = (
            "select id, text, score, artifact_id, page_start, page_end, heading_path, kind "
            f"from txtai where similar(:q, {candidates})"
        )
        if artifact_ids is not None:
            ids = [i for i in artifact_ids if _HEX_ID.match(i)]
            if not ids:
                return []
            sql += " and artifact_id in (" + ", ".join(f"'{i}'" for i in ids) + ")"
        vectors = {} if query_vector is None else {query: np.asarray(query_vector, np.float32)}
        with self._lock, provide(vectors, dims):
            embeddings = self._loaded()
            # weights=0 keeps only the BM25 side when there is no query vector.
            weights = 0.5 if query_vector is not None else 0.0
            return list(embeddings.search(sql, limit, weights=weights, parameters={"q": query}))


class KnowledgeIndexes:
    """The per-user indexes under one root directory."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._users: dict[str, UserIndex] = {}
        self._lock = threading.Lock()

    def for_user(self, user_id: str | None) -> UserIndex:
        """The person's index (created lazily, one object per person)."""
        name = user_dir_name(user_id)
        with self._lock:
            if name not in self._users:
                self._users[name] = UserIndex(self._root / name)
            return self._users[name]
