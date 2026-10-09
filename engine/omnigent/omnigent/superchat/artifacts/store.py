"""Artifact store: one row per saved version of a deliverable file; bytes in the artifact store.

Versions of one deliverable share ``(owner, parent_session_id, name)``: saving the same name
again in the same Conversation adds a version instead of a new file.
"""

from __future__ import annotations

import re
import secrets
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from sqlalchemy import delete, desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlArtifact,
    SqlArtifactPublication,
    SqlArtifactView,
    current_workspace_id,
)
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.stores.artifact_store import ArtifactStore

_BLOB_PREFIX = "muse-artifacts"
_CREATE_ATTEMPTS = 5

AUDIENCES = ("owner", "org", "link")
#: A repeat open by the same viewer within this many seconds is not counted again.
VIEW_DEDUPE_SECONDS = 30
_SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
_SLUG_STEM_MAX = 40
_VIEWER_KEY_MAX = 64


class VersionConflictError(Exception):
    """The base version of a manual edit is no longer the newest version of its group."""

    def __init__(self, newest: int) -> None:
        super().__init__(f"newest version is {newest}")
        self.newest = newest


@dataclass(frozen=True)
class ViewStats:
    """Opens of a published app: all time, distinct viewers and the last 7 UTC days."""

    opens_total: int = 0
    unique_viewers: int = 0
    opens_7d: int = 0

    def as_dict(self) -> dict[str, int]:
        """:returns: The JSON shape."""
        return {
            "opens_total": self.opens_total,
            "unique_viewers": self.unique_viewers,
            "opens_7d": self.opens_7d,
        }


@dataclass(frozen=True)
class Publication:
    """The published state of one deliverable (artifact group)."""

    slug: str
    user_id: str | None
    parent_session_id: str
    name: str
    audience: str
    published_version: int
    published_at: int
    updated_at: int | None

    @property
    def url_path(self) -> str:
        """:returns: The public path the Nova app serves it at."""
        return f"/apps/{self.slug}"


def _to_publication(row: SqlArtifactPublication) -> Publication:
    return Publication(
        slug=row.slug,
        user_id=row.user_id,
        parent_session_id=row.parent_session_id,
        name=row.name,
        audience=row.audience,
        published_version=row.published_version,
        published_at=row.published_at,
        updated_at=row.updated_at,
    )


def make_slug(title: str | None, name: str) -> str:
    """A URL-safe slug from the title (or file stem) plus a short random suffix."""
    base = (title or "").strip() or name.rsplit(".", 1)[0]
    stem = re.sub(r"[^a-z0-9]+", "-", base.lower().encode("ascii", "ignore").decode()).strip("-")
    stem = stem[:_SLUG_STEM_MAX].strip("-") or "app"
    suffix = "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(6))
    return f"{stem}-{suffix}"


def _utc_day(epoch: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(epoch))


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
    :param published: Whether the deliverable is published (filled from its publication).
    :param created_at: Epoch seconds.
    :param updated_at: Epoch seconds of the last change, or ``None``.
    :param origin: ``"ai"``, ``"manual"`` or ``"restore"``.
    :param parent_version_id: Id of the version this one derives from, if any.
    :param source_path: Computer workspace path the file came from / is written back to.
    :param edit_summary: Short human text of a manual edit.
    :param delivered_at: When a manual version was written back and announced, else ``None``.
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
    origin: str = "ai"
    parent_version_id: str | None = None
    source_path: str | None = None
    edit_summary: str | None = None
    delivered_at: int | None = None


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
        origin=row.origin,
        parent_version_id=row.parent_version_id,
        source_path=row.source_path,
        edit_summary=row.edit_summary,
        delivered_at=row.delivered_at,
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
        origin: str = "ai",
        parent_version_id: str | None = None,
        source_path: str | None = None,
        edit_summary: str | None = None,
        base_version: int | None = None,
    ) -> Artifact:
        """Store ``data`` as the next version of ``name`` in the session.

        Safe under concurrent saves: the unique ``(session, name, version)`` index rejects a
        duplicate number and the insert is retried with a fresh one.

        :param base_version: When given, the save only succeeds while this is still the newest
            version of the group; otherwise :class:`VersionConflictError` is raised.
        """
        blobs = self._blob_store()
        artifact_id = uuid.uuid4().hex
        key = f"{_BLOB_PREFIX}/{artifact_id}"
        blobs.put(key, data)
        now = now_epoch()

        def write(session: Session) -> Artifact:
            latest = session.execute(
                select(func.max(SqlArtifact.version)).where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    SqlArtifact.parent_session_id == parent_session_id,
                    SqlArtifact.name == name,
                )
            ).scalar()
            if base_version is not None and (latest or 0) != base_version:
                raise VersionConflictError(latest or 0)
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
                origin=origin,
                parent_version_id=parent_version_id,
                source_path=(source_path or None) and source_path[:1024],
                edit_summary=edit_summary,
                delivered_at=None,
            )
            session.add(row)
            session.flush()
            return _to_entity(row)

        try:
            for attempt in range(_CREATE_ATTEMPTS):
                try:
                    return run_write_transaction(self._session_immediate, "insert_artifact", write)
                except IntegrityError:
                    if attempt == _CREATE_ATTEMPTS - 1:
                        raise
            raise AssertionError("unreachable")  # pragma: no cover
        except Exception:
            blobs.delete(key)
            raise

    def newest(self, item: Artifact) -> Artifact | None:
        """The newest version of ``item``'s group."""
        group = self.versions(item)
        return group[0] if group else None

    def pending_manual(self, *, user_id: str | None, parent_session_id: str) -> list[Artifact]:
        """Manual versions in the session not yet written back / announced, oldest first."""
        with self._session("list_pending_manual_artifacts") as session:
            stmt = (
                select(SqlArtifact)
                .where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    _owner_clause(user_id),
                    SqlArtifact.parent_session_id == parent_session_id,
                    SqlArtifact.origin == "manual",
                    SqlArtifact.delivered_at.is_(None),
                )
                .order_by(SqlArtifact.created_at, SqlArtifact.version)
            )
            return [_to_entity(r) for r in session.execute(stmt).scalars().all()]

    def mark_delivered(self, artifact_id: str, *, user_id: str | None) -> bool:
        """Mark a manual version delivered (idempotent); ``False`` when it is not the caller's."""
        now = now_epoch()

        def write(session: Session) -> bool:
            row = session.get(SqlArtifact, (current_workspace_id(), artifact_id))
            if row is None or row.user_id != user_id:
                return False
            if row.delivered_at is None:
                row.delivered_at = now
            return True

        return run_write_transaction(self._session_immediate, "deliver_artifact", write)

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

    # ------------------------------------------------------------------ publishing

    def publication_for(self, item: Artifact) -> Publication | None:
        """The publication of ``item``'s deliverable, or ``None`` when it is not published."""
        with self._session("select_artifact_publication") as session:
            row = session.execute(
                select(SqlArtifactPublication).where(
                    SqlArtifactPublication.workspace_id == current_workspace_id(),
                    SqlArtifactPublication.parent_session_id == item.parent_session_id,
                    SqlArtifactPublication.name == item.name,
                )
            ).scalar_one_or_none()
            return _to_publication(row) if row is not None else None

    def publications_for_owner(self, user_id: str | None) -> dict[tuple[str, str], Publication]:
        """Every publication of the owner, keyed by ``(parent_session_id, name)``."""
        with self._session("list_artifact_publications") as session:
            rows = session.execute(
                select(SqlArtifactPublication).where(
                    SqlArtifactPublication.workspace_id == current_workspace_id(),
                    SqlArtifactPublication.user_id.is_(None)
                    if user_id is None
                    else SqlArtifactPublication.user_id == user_id,
                )
            ).scalars()
            return {(r.parent_session_id, r.name): _to_publication(r) for r in rows}

    def publish(self, item: Artifact, *, audience: str, version: int | None = None) -> Publication:
        """Publish (or republish) ``item``'s deliverable, pinning ``version`` (default newest).

        Republishing keeps the slug and updates the audience and the pinned version.

        :raises ValueError: for an unknown audience, a non-html kind or an unknown version.
        """
        if audience not in AUDIENCES:
            raise ValueError(f"audience must be one of: {', '.join(AUDIENCES)}")
        if item.kind != "html":
            raise ValueError("only html files can be published")
        group = self.versions(item)
        if not group:
            raise ValueError("artifact not found")
        pinned = group[0].version if version is None else version
        if pinned not in {v.version for v in group}:
            raise ValueError("version not found")
        title = group[0].title
        now = now_epoch()

        def write(session: Session) -> Publication:
            row = session.execute(
                select(SqlArtifactPublication).where(
                    SqlArtifactPublication.workspace_id == current_workspace_id(),
                    SqlArtifactPublication.parent_session_id == item.parent_session_id,
                    SqlArtifactPublication.name == item.name,
                )
            ).scalar_one_or_none()
            if row is not None:
                row.audience = audience
                row.published_version = pinned
                row.updated_at = now
            else:
                row = SqlArtifactPublication(
                    slug=make_slug(title, item.name),
                    user_id=item.user_id,
                    parent_session_id=item.parent_session_id,
                    name=item.name,
                    audience=audience,
                    published_version=pinned,
                    published_at=now,
                    updated_at=None,
                )
                session.add(row)
            session.flush()
            return _to_publication(row)

        for attempt in range(_CREATE_ATTEMPTS):
            try:
                return run_write_transaction(self._session_immediate, "publish_artifact", write)
            except IntegrityError:  # slug collision (or a concurrent first publish)
                if attempt == _CREATE_ATTEMPTS - 1:
                    raise
        raise AssertionError("unreachable")  # pragma: no cover

    def unpublish(self, item: Artifact) -> bool:
        """Remove the publication and its view counts; ``False`` when it was not published."""

        def write(session: Session) -> bool:
            row = session.execute(
                select(SqlArtifactPublication).where(
                    SqlArtifactPublication.workspace_id == current_workspace_id(),
                    SqlArtifactPublication.parent_session_id == item.parent_session_id,
                    SqlArtifactPublication.name == item.name,
                )
            ).scalar_one_or_none()
            if row is None:
                return False
            session.execute(
                delete(SqlArtifactView).where(
                    SqlArtifactView.workspace_id == current_workspace_id(),
                    SqlArtifactView.slug == row.slug,
                )
            )
            session.delete(row)
            return True

        return run_write_transaction(self._session_immediate, "unpublish_artifact", write)

    def published_by_slug(self, slug: str) -> tuple[Publication, Artifact] | None:
        """The publication for ``slug`` with its pinned version row, or ``None``."""
        with self._session("select_published_artifact") as session:
            pub = session.get(SqlArtifactPublication, (current_workspace_id(), slug))
            if pub is None:
                return None
            row = session.execute(
                select(SqlArtifact).where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    SqlArtifact.parent_session_id == pub.parent_session_id,
                    SqlArtifact.name == pub.name,
                    SqlArtifact.version == pub.published_version,
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            return _to_publication(pub), _to_entity(row)

    def record_view(self, slug: str, viewer_key: str) -> bool:
        """Count one open by ``viewer_key``; repeats within ``VIEW_DEDUPE_SECONDS`` are skipped.

        :returns: ``True`` when the open was counted, ``False`` when deduplicated or the slug is
            not published.
        """
        key = viewer_key.strip()[:_VIEWER_KEY_MAX]
        if not key:
            return False
        now = now_epoch()
        day = _utc_day(now)

        def write(session: Session) -> bool:
            ws = current_workspace_id()
            if session.get(SqlArtifactPublication, (ws, slug)) is None:
                return False
            row = session.get(SqlArtifactView, (ws, slug, day, key))
            if row is None:
                session.add(
                    SqlArtifactView(slug=slug, day=day, viewer_key=key, opens=1, last_at=now)
                )
                return True
            if now - row.last_at < VIEW_DEDUPE_SECONDS:
                return False
            row.opens += 1
            row.last_at = now
            return True

        return run_write_transaction(self._session_immediate, "record_artifact_view", write)

    def stats(self, slugs: list[str]) -> dict[str, ViewStats]:
        """Opens per slug (one grouped query)."""
        if not slugs:
            return {}
        cutoff = _utc_day(now_epoch() - 6 * 86400)
        with self._session("select_artifact_view_stats") as session:
            rows = session.execute(
                select(
                    SqlArtifactView.slug,
                    func.sum(SqlArtifactView.opens),
                    func.count(func.distinct(SqlArtifactView.viewer_key)),
                )
                .where(
                    SqlArtifactView.workspace_id == current_workspace_id(),
                    SqlArtifactView.slug.in_(slugs),
                )
                .group_by(SqlArtifactView.slug)
            ).all()
            recent = dict(
                session.execute(
                    select(SqlArtifactView.slug, func.sum(SqlArtifactView.opens))
                    .where(
                        SqlArtifactView.workspace_id == current_workspace_id(),
                        SqlArtifactView.slug.in_(slugs),
                        SqlArtifactView.day >= cutoff,
                    )
                    .group_by(SqlArtifactView.slug)
                ).all()
            )
        return {
            slug: ViewStats(int(total or 0), int(uniq or 0), int(recent.get(slug) or 0))
            for slug, total, uniq in rows
        }

    def delete_group(self, item: Artifact) -> int:
        """Delete every version of ``item``'s deliverable; returns how many were removed."""
        self.unpublish(item)
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
