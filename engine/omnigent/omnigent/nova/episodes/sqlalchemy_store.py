"""SQLAlchemy-backed episode store."""

from __future__ import annotations

import json

from sqlalchemy import desc, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    run_write_transaction,
)
from omnigent.nova._shared import NovaActor, new_id
from omnigent.nova.episodes.entities import Episode
from omnigent.nova.episodes.store import EpisodeStore
from omnigent.nova.episodes.tables import SqlNovaEpisode

# Application-level bounds behind the ``tools``/``links`` column widths in the
# migration (DATABASE_BEST_PRACTICES.md: every column needs an enforced size
# bound, not just a declared length some dialects ignore).
_MAX_TOOLS = 20
_MAX_TOOL_NAME_CHARS = 64
_MAX_LINKS = 8
_MAX_LINK_CHARS = 300


def _encode_list(values: tuple[str, ...], *, max_items: int, max_chars: int) -> str:
    """Compact JSON array, truncated to a bounded item count and item length.

    :param values: The strings to encode.
    :param max_items: Maximum number of items kept.
    :param max_chars: Maximum characters kept per item.
    :returns: A JSON array string, safely under the column's byte cap.
    """
    trimmed = [v[:max_chars] for v in values[:max_items]]
    return json.dumps(trimmed, separators=(",", ":"))


def _decode_list(raw: str) -> tuple[str, ...]:
    """Inverse of :func:`_encode_list`; defensive against a malformed blob.

    :param raw: The stored JSON blob.
    :returns: The decoded strings, or ``()`` if the blob is not a JSON array
        of strings.
    """
    try:
        decoded = json.loads(raw)
    except ValueError:
        return ()
    if not isinstance(decoded, list) or not all(isinstance(v, str) for v in decoded):
        return ()
    return tuple(decoded)


def _to_entity(row: SqlNovaEpisode) -> Episode:
    """
    Convert a :class:`SqlNovaEpisode` ORM row to an :class:`Episode`.

    :param row: The SQLAlchemy ORM row to convert.
    :returns: An :class:`Episode` dataclass instance.
    """
    return Episode(
        id=row.id,
        workspace_id=row.workspace_id,
        user_id=row.user_id,
        session_id=row.session_id,
        turn_id=row.turn_id,
        title=row.title,
        summary=row.summary,
        tools=_decode_list(row.tools),
        links=_decode_list(row.links),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class SqlAlchemyEpisodeStore(EpisodeStore):
    """SQLAlchemy-backed implementation of :class:`EpisodeStore`."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g.
            ``"sqlite:///chat.db"``.
        """
        super().__init__(storage_location)
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.nova_episode_store",
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine,
            query_name_prefix="omnigent.nova_episode_store",
            immediate=True,
        )

    def upsert(
        self,
        *,
        actor: NovaActor,
        session_id: str,
        turn_id: str,
        title: str,
        summary: str,
        tools: tuple[str, ...],
        links: tuple[str, ...],
        created_at: int,
    ) -> Episode:
        """Insert a new episode, or update the existing row for this turn.

        The unique index on ``(workspace_id, session_id, turn_id)`` is the
        conflict target; an update never changes the row's original id.
        """
        tools_json = _encode_list(tools, max_items=_MAX_TOOLS, max_chars=_MAX_TOOL_NAME_CHARS)
        links_json = _encode_list(links, max_items=_MAX_LINKS, max_chars=_MAX_LINK_CHARS)
        workspace_id = actor.workspace_id
        values = {
            "workspace_id": workspace_id,
            "id": new_id(),
            "user_id": actor.user_id,
            "session_id": session_id,
            "turn_id": turn_id,
            "title": title,
            "summary": summary,
            "tools": tools_json,
            "links": links_json,
            "created_at": created_at,
            "updated_at": None,
        }
        update_values = {
            "title": title,
            "summary": summary,
            "tools": tools_json,
            "links": links_json,
            "updated_at": created_at,
        }

        def write(session: Session) -> Episode:
            dialect = self._engine.dialect.name
            conflict_columns = ["workspace_id", "session_id", "turn_id"]
            if dialect == "mysql":
                stmt = (
                    mysql_insert(SqlNovaEpisode)
                    .values(**values)
                    .on_duplicate_key_update(**update_values)
                )
            elif dialect == "sqlite":
                stmt = (
                    sqlite_insert(SqlNovaEpisode)
                    .values(**values)
                    .on_conflict_do_update(index_elements=conflict_columns, set_=update_values)
                )
            else:
                stmt = (
                    pg_insert(SqlNovaEpisode)
                    .values(**values)
                    .on_conflict_do_update(index_elements=conflict_columns, set_=update_values)
                )
            session.execute(stmt)
            row = session.execute(
                select(SqlNovaEpisode).where(
                    SqlNovaEpisode.workspace_id == workspace_id,
                    SqlNovaEpisode.session_id == session_id,
                    SqlNovaEpisode.turn_id == turn_id,
                )
            ).scalar_one()
            return _to_entity(row)

        return run_write_transaction(self._session_immediate, "upsert_episode", write)

    def list_recent(self, *, actor: NovaActor, limit: int) -> list[Episode]:
        """List the person's most recent episodes, newest first.

        Scans the ascending ``ix_nova_episodes_user`` index backward, per
        DATABASE_BEST_PRACTICES.md's rule against descending indexes.
        """
        with self._session("list_recent_episodes") as session:
            stmt = (
                select(SqlNovaEpisode)
                .where(SqlNovaEpisode.workspace_id == actor.workspace_id)
                .where(SqlNovaEpisode.user_id == actor.user_id)
                .order_by(desc(SqlNovaEpisode.created_at), desc(SqlNovaEpisode.id))
                .limit(limit)
            )
            rows = session.execute(stmt).scalars().all()
            return [_to_entity(r) for r in rows]

    def delete(self, episode_id: str, *, actor: NovaActor) -> bool:
        """Delete one of the person's episodes. Idempotent."""

        def write(session: Session) -> bool:
            row = session.get(SqlNovaEpisode, (actor.workspace_id, episode_id))
            if row is None or row.user_id != actor.user_id:
                return False
            session.delete(row)
            return True

        return run_write_transaction(self._session_immediate, "delete_episode", write)
