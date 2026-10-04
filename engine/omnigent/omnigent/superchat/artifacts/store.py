"""Artifact store: one row per saved version of a deliverable file; bytes in the artifact store.

Versions of one deliverable share ``(owner, parent_session_id, name)``: saving the same name
again in the same Conversation adds a version instead of a new file.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import SqlArtifact, current_workspace_id
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.stores.artifact_store import ArtifactStore

_BLOB_PREFIX = "muse-artifacts"


@dataclass
class Artifact:
    """One saved version of a deliverable file.

    :param id: Bare 32-char hex id of this version.
    :param user_id: Owner, or ``None`` in single-user mode.
    :param parent_session_id: The Conversation it belongs to.
    :param name: File name (groups versions).
    :param title: Display title, if given.
    :param kind: One of the allow-listed kinds.
    :param mime: Served content type.
    :param size: Byte length.
    :param version: 1-based version within the group.
    :param blob_key: Artifact-store key of the bytes.
    :param published: Reserved for a later publish feature.
    :param created_at: Epoch seconds.
    :param updated_at: Epoch seconds of the last change, or ``None``.
    """

    id: str
    user_id: str | None
    parent_session_id: str
    name: str
    title: str | None
    kind: str
    mime: str
    size: int
    version: int
    blob_key: str
    published: bool
    created_at: int
    updated_at: int | None


def _to_entity(row: SqlArtifact) -> Artifact:
    return Artifact(
        id=row.id,
        user_id=row.user_id,
        parent_session_id=row.parent_session_id,
        name=row.name,
        title=row.title,
        kind=row.kind,
        mime=row.mime,
        size=row.size,
        version=row.version,
        blob_key=row.blob_key,
        published=bool(row.published),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _owner_clause(user_id: str | None):  # type: ignore[no-untyped-def]
    return SqlArtifact.user_id.is_(None) if user_id is None else SqlArtifact.user_id == user_id


class SqlAlchemyArtifactStore:
    """SQLAlchemy-backed store for the ``artifacts`` table (owner-scoped) plus its blobs."""

    def __init__(
        self,
        storage_location: str,
        blobs: Callable[[], ArtifactStore | None],
    ) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        :param blobs: Returns the engine's artifact (blob) store, resolved lazily because the
            runtime sets it after the routers are built.
        """
        self.storage_location = storage_location
        self._blobs = blobs
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.artifact_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.artifact_store", immediate=True
        )

    def _blob_store(self) -> ArtifactStore:
        store = self._blobs()
        if store is None:
            raise RuntimeError("artifact blob store is not configured")
        return store

    def create(
        self,
        *,
        user_id: str | None,
        parent_session_id: str,
        name: str,
        title: str | None,
        kind: str,
        mime: str,
        data: bytes,
    ) -> Artifact:
        """Store ``data`` as the next version of ``name`` in the session."""
        blobs = self._blob_store()
        artifact_id = uuid.uuid4().hex
        key = f"{_BLOB_PREFIX}/{artifact_id}"
        blobs.put(key, data)
        now = now_epoch()

        def write(session: Session) -> Artifact:
            latest = session.execute(
                select(func.max(SqlArtifact.version)).where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    _owner_clause(user_id),
                    SqlArtifact.parent_session_id == parent_session_id,
                    SqlArtifact.name == name,
                )
            ).scalar()
            row = SqlArtifact(
                id=artifact_id,
                user_id=user_id,
                parent_session_id=parent_session_id,
                name=name,
                title=(title or "").strip()[:256] or None,
                kind=kind,
                mime=mime,
                size=len(data),
                version=(latest or 0) + 1,
                blob_key=key,
                published=False,
                created_at=now,
                updated_at=None,
            )
            session.add(row)
            session.flush()
            return _to_entity(row)

        try:
            return run_write_transaction(self._session_immediate, "insert_artifact", write)
        except Exception:
            blobs.delete(key)
            raise

    def get(self, artifact_id: str, *, user_id: str | None) -> Artifact | None:
        """Return the owner's artifact version, or ``None`` (also for another owner's)."""
        with self._session("select_artifact") as session:
            row = session.get(SqlArtifact, (current_workspace_id(), artifact_id))
            if row is None or row.user_id != user_id:
                return None
            return _to_entity(row)

    def versions(self, item: Artifact) -> list[Artifact]:
        """Every version of ``item``'s group, newest first."""
        with self._session("list_artifact_versions") as session:
            stmt = (
                select(SqlArtifact)
                .where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    _owner_clause(item.user_id),
                    SqlArtifact.parent_session_id == item.parent_session_id,
                    SqlArtifact.name == item.name,
                )
                .order_by(desc(SqlArtifact.version))
            )
            return [_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def list_latest(
        self,
        *,
        user_id: str | None,
        parent_session_id: str | None = None,
        limit: int = 200,
    ) -> list[tuple[Artifact, int]]:
        """The newest version of each deliverable (with its version count), newest first."""
        with self._session("list_artifacts") as session:
            stmt = select(SqlArtifact).where(
                SqlArtifact.workspace_id == current_workspace_id(), _owner_clause(user_id)
            )
            if parent_session_id is not None:
                stmt = stmt.where(SqlArtifact.parent_session_id == parent_session_id)
            rows = session.execute(
                stmt.order_by(desc(SqlArtifact.created_at), desc(SqlArtifact.version))
            ).scalars()
            groups: dict[tuple[str, str], tuple[Artifact, int]] = {}
            for row in rows:
                key = (row.parent_session_id, row.name)
                if key in groups:
                    groups[key] = (groups[key][0], groups[key][1] + 1)
                else:
                    groups[key] = (_to_entity(row), 1)
            return list(groups.values())[:limit]

    def read(self, item: Artifact) -> bytes:
        """The bytes of one version."""
        return self._blob_store().get(item.blob_key)

    def delete_group(self, item: Artifact) -> int:
        """Delete every version of ``item``'s deliverable; returns how many were removed."""
        group = self.versions(item)

        def write(session: Session) -> None:
            for version in group:
                row = session.get(SqlArtifact, (current_workspace_id(), version.id))
                if row is not None:
                    session.delete(row)

        run_write_transaction(self._session_immediate, "delete_artifact", write)
        blobs = self._blob_store()
        for version in group:
            blobs.delete(version.blob_key)
        return len(group)
