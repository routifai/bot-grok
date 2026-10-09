"""The txtai ``external`` transform that serves vectors we already hold.

The embeddings are made through the model layer and stored in ``file_chunks``, so txtai must never
call a provider itself. Around each index or search call the index code :func:`provide`s a
``{text: vector}`` map; :func:`stored_vectors` (re-importable by dotted path, which txtai needs to
reload a saved index) answers from it. A text without a vector (a keyword-only chunk, or the query
of a keyword search) gets a constant unit vector, which ranks every such text the same.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

import numpy as np

TRANSFORM_PATH = "omnigent.superchat.knowledge.vectors.stored_vectors"


@dataclass(frozen=True)
class _Provided:
    vectors: Mapping[str, Any]
    dims: int


_active: ContextVar[_Provided | None] = ContextVar("knowledge_vectors", default=None)


def placeholder(dims: int) -> np.ndarray:
    """The vector of a text that has none: the first basis vector."""
    vector = np.zeros(dims, dtype=np.float32)
    vector[0] = 1.0
    return vector


@contextmanager
def provide(vectors: Mapping[str, Any], dims: int) -> Iterator[None]:
    """Make *vectors* (``text -> vector``) the answers of :func:`stored_vectors` in this block."""
    token = _active.set(_Provided(vectors, dims))
    try:
        yield
    finally:
        _active.reset(token)


def stored_vectors(data: list[str]) -> np.ndarray:
    """The txtai transform: one stored vector per text (see the module docstring)."""
    provided = _active.get()
    if provided is None:
        raise RuntimeError("knowledge vectors are only available inside vectors.provide()")
    rows = []
    for text in data:
        vector = provided.vectors.get(text)
        rows.append(
            placeholder(provided.dims) if vector is None else np.asarray(vector, np.float32)
        )
    return np.vstack(rows)
