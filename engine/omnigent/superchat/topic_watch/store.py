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

from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlArtifact,
    SqlConversation,
    SqlConversationLabel,
    SqlTopicWatchCursor,
    SqlTopicWatchRun,
    SqlTopicWatchSeen,
    SqlTopicWatchTerm,
    current_workspace_id,
)
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.superchat.topic_watch.rules import COMMON_WINDOW_DAYS, Ledger

#: Outcomes the limits count: a message sent, or one held for quiet hours.
SPOKEN = ("messaged", "held")
#: How long a seen item is kept; a spoken one longer (a thread is never surfaced twice).
SEEN_KEEP_SECONDS = 30 * 24 * 3600
SPOKEN_KEEP_SECONDS = 365 * 24 * 3600
#: How far back the ledger reads the per-topic times and today's count.
LEDGER_WINDOW_SECONDS = 30 * 24 * 3600
#: Runs kept per owner.
RUNS_KEPT = 500
#: The longest term the counts keep (the column's width); longer terms are cut to it.
TERM_CHARS = 128


def day_of(epoch: int) -> int:
    """The UTC day number the term counts are kept by."""
    return epoch // 86400


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

    # ------------------------------------------------------------------ term counts

    def term_counts(self, owner: str, terms: Sequence[str]) -> dict[str, tuple[int, int]]:
        """``term -> (items containing it, items seen while watched)`` over the window.

        The window is the last :data:`~omnigent.superchat.topic_watch.rules.COMMON_WINDOW_DAYS`
        UTC days, today included. Terms are normalized; a term with no rows is left out.
        """
        keys = list({t[:TERM_CHARS] for t in terms if t})
        if not keys:
            return {}
        since = day_of(now_epoch()) - COMMON_WINDOW_DAYS + 1
        row = SqlTopicWatchTerm
        with self._session("select_topic_watch_terms") as session:
            rows = session.execute(
                select(row.term, func.sum(row.hits), func.sum(row.items))
                .where(
                    row.workspace_id == current_workspace_id(),
                    row.owner == owner,
                    row.day >= since,
                    row.term.in_(keys),
                )
                .group_by(row.term)
            ).all()
            return {term: (int(hits or 0), int(items or 0)) for term, hits, items in rows}

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
        """The messages the limits count: newest per topic, threads spoken of, today's count.

        The per-topic times and today's count read the last :data:`LEDGER_WINDOW_SECONDS` only
        (the limits look back 3 hours and one day); the threads read every spoken row kept
        (:data:`SPOKEN_KEEP_SECONDS`), since a thread never surfaces twice. Columns only: a
        held row's payload is never loaded here.
        """
        ledger = Ledger()
        seen = SqlTopicWatchSeen
        mine = (
            seen.workspace_id == current_workspace_id(),
            seen.owner == owner,
            seen.outcome.in_(SPOKEN),
        )
        since = min(day_start, now_epoch() - LEDGER_WINDOW_SECONDS)
        with self._session("select_topic_watch_ledger") as session:
            recent = session.execute(
                select(seen.topic_key, seen.at).where(*mine, seen.at >= since)
            ).all()
            for topic_key, at in recent:
                if topic_key:
                    ledger.topic_last[topic_key] = max(ledger.topic_last.get(topic_key, 0), at)
                if at >= day_start:
                    ledger.today += 1
            threads = session.execute(
                select(func.coalesce(seen.thread_ref, func.substr(seen.item_key, 1, 255)))
                .where(*mine)
                .distinct()
            ).scalars()
            ledger.threads.update(threads)
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
        terms: dict[str, tuple[int, int]] | None = None,
    ) -> str:
        """Write one run at once: the items' outcomes, the moved cursors and the run record.

        :param terms: ``term -> (items containing it, items seen)`` this run adds to today's
            term counts.

        Old seen rows, term counts past the window and old runs are pruned in the same write.

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
            today = day_of(now)
            added: dict[str, tuple[int, int]] = {}
            for term, (hits, items) in (terms or {}).items():
                key = term[:TERM_CHARS]
                if key and items > 0:
                    was = added.get(key, (0, 0))
                    added[key] = (was[0] + hits, was[1] + items)
            for key, (hits, items) in added.items():
                counted = session.get(SqlTopicWatchTerm, (workspace, owner, today, key))
                if counted is None:
                    session.add(
                        SqlTopicWatchTerm(
                            workspace_id=workspace,
                            owner=owner,
                            day=today,
                            term=key,
                            items=items,
                            hits=hits,
                        )
                    )
                else:
                    counted.items += items
                    counted.hits += hits
            session.execute(
                delete(SqlTopicWatchTerm).where(
                    SqlTopicWatchTerm.workspace_id == workspace,
                    SqlTopicWatchTerm.owner == owner,
                    SqlTopicWatchTerm.day <= today - COMMON_WINDOW_DAYS,
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
