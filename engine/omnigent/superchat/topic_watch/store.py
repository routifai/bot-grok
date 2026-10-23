"""Topic watch store: cursors, the seen-set and ledger, and the run record (owner-scoped).

Also the one read of the Library topic watch needs (versions saved since a time), straight
from the shared ``artifacts`` table, so this capability imports no other.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlArtifact,
    SqlConversation,
    SqlConversationLabel,
    SqlTopicWatchCursor,
    SqlTopicWatchRun,
    SqlTopicWatchSeen,
    current_workspace_id,
)
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.superchat.topic_watch.rules import Ledger

#: Outcomes the limits count: a message sent, or one held for quiet hours.
SPOKEN = ("messaged", "held")
#: How long a seen item is kept; a spoken one longer (a thread is never surfaced twice).
SEEN_KEEP_SECONDS = 30 * 24 * 3600
SPOKEN_KEEP_SECONDS = 365 * 24 * 3600
#: Runs kept per owner.
RUNS_KEPT = 500


@dataclass(frozen=True)
class SeenRow:
    """One item's outcome, as written to ``topic_watch_seen``."""

    item_key: str
    source: str
    outcome: str
    thread_ref: str | None = None
    topic_key: str | None = None
    line: str | None = None
    payload: dict[str, Any] | None = None


class SqlAlchemyTopicWatchStore:
    """SQLAlchemy-backed store for the ``topic_watch_*`` tables."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        """
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.topic_watch_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.topic_watch_store", immediate=True
        )

    # ------------------------------------------------------------------ cursors

    def cursors(self, owner: str) -> dict[str, str]:
        """``source -> cursor`` for the owner."""
        with self._session("select_topic_watch_cursors") as session:
            rows = session.execute(
                select(SqlTopicWatchCursor).where(
                    SqlTopicWatchCursor.workspace_id == current_workspace_id(),
                    SqlTopicWatchCursor.owner == owner,
                )
            ).scalars()
            return {row.source: row.cursor for row in rows}

    # ------------------------------------------------------------------ seen-set and ledger

    def seen(self, owner: str, keys: Sequence[str]) -> set[str]:
        """Which of *keys* the owner's watch already looked at."""
        if not keys:
            return set()
        with self._session("select_topic_watch_seen") as session:
            rows = session.execute(
                select(SqlTopicWatchSeen.item_key).where(
                    SqlTopicWatchSeen.workspace_id == current_workspace_id(),
                    SqlTopicWatchSeen.owner == owner,
                    SqlTopicWatchSeen.item_key.in_(list(set(keys))),
                )
            ).scalars()
            return set(rows)

    def ledger(self, owner: str, *, day_start: int) -> Ledger:
        """The messages the limits count: newest per topic, threads spoken of, today's count."""
        ledger = Ledger()
        with self._session("select_topic_watch_ledger") as session:
            rows = session.execute(
                select(SqlTopicWatchSeen).where(
                    SqlTopicWatchSeen.workspace_id == current_workspace_id(),
                    SqlTopicWatchSeen.owner == owner,
                    SqlTopicWatchSeen.outcome.in_(SPOKEN),
                )
            ).scalars()
            for row in rows:
                if row.topic_key:
                    ledger.topic_last[row.topic_key] = max(
                        ledger.topic_last.get(row.topic_key, 0), row.at
                    )
                ledger.threads.add(row.thread_ref or row.item_key[:255])
                if row.at >= day_start:
                    ledger.today += 1
        return ledger

    def held(self, owner: str) -> list[SeenRow]:
        """Messages held for quiet hours, oldest first."""
        with self._session("select_topic_watch_held") as session:
            rows = session.execute(
                select(SqlTopicWatchSeen)
                .where(
                    SqlTopicWatchSeen.workspace_id == current_workspace_id(),
                    SqlTopicWatchSeen.owner == owner,
                    SqlTopicWatchSeen.outcome == "held",
                )
                .order_by(SqlTopicWatchSeen.at)
            ).scalars()
            return [
                SeenRow(
                    row.item_key,
                    row.source,
                    row.outcome,
                    row.thread_ref,
                    row.topic_key,
                    row.line,
                    json.loads(row.payload) if row.payload else None,
                )
                for row in rows
            ]

    def set_outcome(self, owner: str, item_key: str, outcome: str) -> None:
        """Change one seen item's outcome (a held message that went out)."""

        def write(session: Session) -> None:
            row = session.get(SqlTopicWatchSeen, (current_workspace_id(), owner, item_key))
            if row is not None:
                row.outcome = outcome
                row.at = now_epoch()

        run_write_transaction(self._session_immediate, "update_topic_watch_seen", write)

    def finish_run(
        self,
        owner: str,
        *,
        rows: Sequence[SeenRow],
        cursors: dict[str, str],
        run: dict[str, Any],
    ) -> str:
        """Write one run at once: the items' outcomes, the moved cursors and the run record.

        Old seen rows and old runs are pruned in the same write.

        :returns: The run's id.
        """
        now = now_epoch()
        run_id = uuid.uuid4().hex

        def write(session: Session) -> str:
            workspace = current_workspace_id()
            for row in rows:
                session.merge(
                    SqlTopicWatchSeen(
                        workspace_id=workspace,
                        owner=owner,
                        item_key=row.item_key,
                        source=row.source,
                        thread_ref=row.thread_ref,
                        topic_key=row.topic_key,
                        outcome=row.outcome,
                        line=row.line[:512] if row.line else None,
                        payload=json.dumps(row.payload) if row.payload else None,
                        at=now,
                    )
                )
            for source, cursor in cursors.items():
                session.merge(
                    SqlTopicWatchCursor(
                        workspace_id=workspace,
                        owner=owner,
                        source=source,
                        cursor=cursor[:512],
                        updated_at=now,
                    )
                )
            session.add(
                SqlTopicWatchRun(
                    workspace_id=workspace,
                    id=run_id,
                    owner=owner,
                    scheduled_task_id=run.get("scheduled_task_id"),
                    status=run["status"],
                    reason=run.get("reason"),
                    counts=json.dumps(run.get("counts") or {}),
                    detail=json.dumps(run.get("detail") or {}),
                    started_at=run["started_at"],
                    finished_at=now,
                )
            )
            mine = (SqlTopicWatchSeen.workspace_id == workspace, SqlTopicWatchSeen.owner == owner)
            session.execute(
                delete(SqlTopicWatchSeen).where(
                    *mine,
                    SqlTopicWatchSeen.outcome.not_in(SPOKEN),
                    SqlTopicWatchSeen.at < now - SEEN_KEEP_SECONDS,
                )
            )
            session.execute(
                delete(SqlTopicWatchSeen).where(
                    *mine, SqlTopicWatchSeen.at < now - SPOKEN_KEEP_SECONDS
                )
            )
            stale = (
                select(SqlTopicWatchRun.id)
                .where(SqlTopicWatchRun.workspace_id == workspace, SqlTopicWatchRun.owner == owner)
                .order_by(desc(SqlTopicWatchRun.started_at))
                .offset(RUNS_KEPT)
            )
            session.execute(
                delete(SqlTopicWatchRun).where(
                    SqlTopicWatchRun.workspace_id == workspace,
                    SqlTopicWatchRun.id.in_(list(session.execute(stale).scalars())),
                )
            )
            return run_id

        return run_write_transaction(self._session_immediate, "write_topic_watch_run", write)

    def runs(self, owner: str, *, limit: int = 20) -> list[dict[str, Any]]:
        """The owner's newest runs, newest first, as plain dicts."""
        with self._session("list_topic_watch_runs") as session:
            rows = session.execute(
                select(SqlTopicWatchRun)
                .where(
                    SqlTopicWatchRun.workspace_id == current_workspace_id(),
                    SqlTopicWatchRun.owner == owner,
                )
                .order_by(desc(SqlTopicWatchRun.started_at))
                .limit(limit)
            ).scalars()
            return [
                {
                    "id": row.id,
                    "status": row.status,
                    "reason": row.reason,
                    "counts": json.loads(row.counts),
                    "detail": json.loads(row.detail),
                    "started_at": row.started_at,
                    "finished_at": row.finished_at,
                }
                for row in rows
            ]

    # ------------------------------------------------------------------ what the watch reads

    def file_versions_since(
        self, user_id: str | None, since: int, limit: int
    ) -> list[dict[str, Any]]:
        """Library versions the owner saved at or after *since*, oldest first."""
        owner = (
            SqlArtifact.user_id.is_(None) if user_id is None else SqlArtifact.user_id == user_id
        )
        with self._session("select_topic_watch_files") as session:
            rows = session.execute(
                select(SqlArtifact)
                .where(
                    SqlArtifact.workspace_id == current_workspace_id(),
                    owner,
                    SqlArtifact.created_at >= since,
                )
                .order_by(SqlArtifact.created_at, SqlArtifact.version)
                .limit(limit)
            ).scalars()
            columns = (
                "id",
                "name",
                "title",
                "mime",
                "blob_key",
                "created_at",
                "origin",
                "source_path",
                "group_id",
            )
            return [{c: getattr(row, c) for c in columns} for row in rows]

    def conversations(self, label_key: str) -> list[str]:
        """Ids of the unarchived sessions carrying *label_key* = ``true``, newest first."""
        workspace = current_workspace_id()
        with self._session("select_topic_watch_conversations") as session:
            rows = session.execute(
                select(SqlConversation.id)
                .join(
                    SqlConversationLabel,
                    (SqlConversationLabel.workspace_id == SqlConversation.workspace_id)
                    & (SqlConversationLabel.conversation_id == SqlConversation.id),
                )
                .where(
                    SqlConversation.workspace_id == workspace,
                    SqlConversationLabel.key == label_key,
                    SqlConversationLabel.value == "true",
                    SqlConversation.archived.is_(False),
                )
                .order_by(desc(SqlConversation.updated_at))
            ).scalars()
            return list(rows)
