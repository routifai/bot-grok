"""Taught-skill store: computer recordings, their keyframes, and the skills drafted from them.

Keyframes are downscaled JPEGs kept server-side (never in the Computer). A skill's document is
versioned: every draft or edit adds a ``taught_skill_versions`` row and bumps ``version``.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from omnigent.db.db_models import (
    SqlComputerRecording,
    SqlRecordingKeyframe,
    SqlTaughtSkill,
    SqlTaughtSkillVersion,
    current_workspace_id,
)
from omnigent.db.utils import (
    get_or_create_engine,
    make_named_managed_session_maker,
    now_epoch,
    run_write_transaction,
)
from omnigent.entities.taught_skill import ComputerRecording, TaughtSkill

_MAX_NAME = 256


def _recording_entity(row: SqlComputerRecording) -> ComputerRecording:
    return ComputerRecording(
        id=row.id,
        user_id=row.user_id,
        session_id=row.session_id,
        goal=row.goal,
        status=row.status,
        started_at=row.started_at,
        actions=json.loads(row.actions) if row.actions else [],
        stopped_at=row.stopped_at,
    )


def _skill_entity(row: SqlTaughtSkill) -> TaughtSkill:
    return TaughtSkill(
        id=row.id,
        user_id=row.user_id,
        parent_session_id=row.parent_session_id,
        recording_id=row.recording_id,
        name=row.name,
        goal=row.goal,
        status=row.status,
        doc=json.loads(row.doc) if row.doc else None,
        version=row.version,
        created_at=row.created_at,
        updated_at=row.updated_at,
        stopped_at=row.stopped_at,
    )


class SqlAlchemyTaughtSkillStore:
    """SQLAlchemy-backed store for recordings and taught skills (owner-scoped)."""

    def __init__(self, storage_location: str) -> None:
        """
        :param storage_location: SQLAlchemy database URI, e.g. ``"sqlite:///chat.db"``.
        """
        self.storage_location = storage_location
        self._engine = get_or_create_engine(storage_location)
        self._session = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.taught_skill_store"
        )
        self._session_immediate = make_named_managed_session_maker(
            self._engine, query_name_prefix="omnigent.taught_skill_store", immediate=True
        )

    # ── recordings ─────────────────────────────────────────────────────────

    def start_recording(
        self,
        recording_id: str,
        skill_id: str,
        *,
        user_id: str | None,
        session_id: str,
        goal: str,
    ) -> tuple[ComputerRecording, TaughtSkill]:
        """Insert a recording and the (still empty) skill it will become."""
        now = now_epoch()

        def write(session: Session) -> tuple[ComputerRecording, TaughtSkill]:
            recording = SqlComputerRecording(
                id=recording_id,
                user_id=user_id,
                session_id=session_id,
                goal=goal,
                status="recording",
                actions=None,
                started_at=now,
                stopped_at=None,
            )
            skill = SqlTaughtSkill(
                id=skill_id,
                user_id=user_id,
                parent_session_id=session_id,
                recording_id=recording_id,
                name="",
                goal=goal,
                status="recording",
                doc=None,
                version=0,
                created_at=now,
                updated_at=None,
                stopped_at=None,
            )
            session.add_all([recording, skill])
            session.flush()
            return _recording_entity(recording), _skill_entity(skill)

        return run_write_transaction(self._session_immediate, "insert_recording", write)

    def active_recording(
        self, session_id: str, *, user_id: str | None
    ) -> ComputerRecording | None:
        """The owner's recording in progress on a session, or ``None``."""
        with self._session("select_active_recording") as session:
            row = (
                session.execute(
                    select(SqlComputerRecording).where(
                        SqlComputerRecording.workspace_id == current_workspace_id(),
                        SqlComputerRecording.session_id == session_id,
                        SqlComputerRecording.status == "recording",
                    )
                )
                .scalars()
                .first()
            )
            if row is None or row.user_id != user_id:
                return None
            return _recording_entity(row)

    def get_recording(self, recording_id: str) -> ComputerRecording | None:
        """The recording, or ``None``."""
        with self._session("select_recording") as session:
            row = session.get(SqlComputerRecording, (current_workspace_id(), recording_id))
            return _recording_entity(row) if row is not None else None

    def finish_recording(
        self,
        recording_id: str,
        *,
        actions: list[dict[str, Any]],
        keyframes: dict[str, bytes],
    ) -> tuple[ComputerRecording, TaughtSkill] | None:
        """Store the trace and keyframes; the skill moves to ``drafting``."""
        now = now_epoch()

        def write(session: Session) -> tuple[ComputerRecording, TaughtSkill] | None:
            ws = current_workspace_id()
            row = session.get(SqlComputerRecording, (ws, recording_id))
            if row is None or row.status != "recording":
                return None
            row.status = "stopped"
            row.actions = json.dumps(actions)
            row.stopped_at = now
            for name, jpeg in keyframes.items():
                session.add(
                    SqlRecordingKeyframe(
                        recording_id=recording_id, name=name, jpeg=jpeg, created_at=now
                    )
                )
            skill = self._skill_of_recording(session, recording_id)
            if skill is not None:
                skill.status = "drafting"
                skill.stopped_at = now
                skill.updated_at = now
            session.flush()
            return _recording_entity(row), _skill_entity(skill)

        return run_write_transaction(self._session_immediate, "finish_recording", write)

    def fail_recording(self, recording_id: str) -> None:
        """Mark a recording, and its skill, failed."""
        now = now_epoch()

        def write(session: Session) -> None:
            row = session.get(SqlComputerRecording, (current_workspace_id(), recording_id))
            if row is not None:
                row.status = "failed"
                row.stopped_at = now
            skill = self._skill_of_recording(session, recording_id)
            if skill is not None:
                skill.status = "failed"
                skill.stopped_at = now
                skill.updated_at = now

        run_write_transaction(self._session_immediate, "fail_recording", write)

    @staticmethod
    def _skill_of_recording(session: Session, recording_id: str) -> SqlTaughtSkill | None:
        return (
            session.execute(
                select(SqlTaughtSkill).where(
                    SqlTaughtSkill.workspace_id == current_workspace_id(),
                    SqlTaughtSkill.recording_id == recording_id,
                )
            )
            .scalars()
            .first()
        )

    def keyframe(self, recording_id: str, name: str) -> bytes | None:
        """One keyframe's JPEG bytes, or ``None``."""
        with self._session("select_keyframe") as session:
            row = session.get(SqlRecordingKeyframe, (current_workspace_id(), recording_id, name))
            return bytes(row.jpeg) if row is not None else None

    def keyframe_names(self, recording_id: str) -> list[str]:
        """Names of a recording's stored keyframes."""
        with self._session("list_keyframes") as session:
            rows = session.execute(
                select(SqlRecordingKeyframe.name).where(
                    SqlRecordingKeyframe.workspace_id == current_workspace_id(),
                    SqlRecordingKeyframe.recording_id == recording_id,
                )
            ).scalars()
            return sorted(rows, key=lambda n: int(n[1:]) if n[1:].isdigit() else 0)

    # ── skills ─────────────────────────────────────────────────────────────

    def get_skill(self, skill_id: str, *, user_id: str | None) -> TaughtSkill | None:
        """The owner's skill, or ``None`` (also for another owner's)."""
        with self._session("select_taught_skill") as session:
            row = session.get(SqlTaughtSkill, (current_workspace_id(), skill_id))
            if row is None or row.user_id != user_id:
                return None
            return _skill_entity(row)

    def list_skills(
        self,
        *,
        user_id: str | None,
        parent_session_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[TaughtSkill]:
        """List the owner's skills, newest first."""
        with self._session("list_taught_skills") as session:
            stmt = select(SqlTaughtSkill).where(
                SqlTaughtSkill.workspace_id == current_workspace_id()
            )
            if user_id is None:
                stmt = stmt.where(SqlTaughtSkill.user_id.is_(None))
            else:
                stmt = stmt.where(SqlTaughtSkill.user_id == user_id)
            if parent_session_id is not None:
                stmt = stmt.where(SqlTaughtSkill.parent_session_id == parent_session_id)
            if status is not None:
                stmt = stmt.where(SqlTaughtSkill.status == status)
            stmt = stmt.order_by(desc(SqlTaughtSkill.created_at), desc(SqlTaughtSkill.id)).limit(
                limit
            )
            return [_skill_entity(r) for r in session.execute(stmt).scalars().all()]

    def save_doc(
        self, skill_id: str, *, user_id: str | None, doc: dict[str, Any]
    ) -> TaughtSkill | None:
        """
        Write a new version of the skill's document.

        A skill that was still drafting (or failed) becomes a ``draft``; a draft or saved skill
        keeps its status. A recording in progress is not editable (``None``).
        """
        now = now_epoch()

        def write(session: Session) -> TaughtSkill | None:
            row = session.get(SqlTaughtSkill, (current_workspace_id(), skill_id))
            if row is None or row.user_id != user_id or row.status == "recording":
                return None
            row.version += 1
            row.doc = json.dumps(doc)
            row.name = str(doc.get("name", ""))[:_MAX_NAME]
            if row.status in ("drafting", "failed"):
                row.status = "draft"
            row.updated_at = now
            session.add(
                SqlTaughtSkillVersion(
                    skill_id=skill_id, version=row.version, doc=row.doc, created_at=now
                )
            )
            session.flush()
            return _skill_entity(row)

        return run_write_transaction(self._session_immediate, "save_taught_skill_doc", write)

    def set_status(self, skill_id: str, *, user_id: str | None, status: str) -> TaughtSkill | None:
        """Set a skill's status (``saved``, or ``failed`` for a draft that never arrived)."""
        now = now_epoch()

        def write(session: Session) -> TaughtSkill | None:
            row = session.get(SqlTaughtSkill, (current_workspace_id(), skill_id))
            if row is None or row.user_id != user_id:
                return None
            row.status = status
            row.updated_at = now
            session.flush()
            return _skill_entity(row)

        return run_write_transaction(self._session_immediate, "set_taught_skill_status", write)

    def versions(self, skill_id: str) -> list[int]:
        """Version numbers kept for a skill, oldest first."""
        with self._session("list_taught_skill_versions") as session:
            return list(
                session.execute(
                    select(SqlTaughtSkillVersion.version)
                    .where(
                        SqlTaughtSkillVersion.workspace_id == current_workspace_id(),
                        SqlTaughtSkillVersion.skill_id == skill_id,
                    )
                    .order_by(SqlTaughtSkillVersion.version)
                ).scalars()
            )

    def delete_skill(self, skill_id: str, *, user_id: str | None) -> bool:
        """Delete the owner's skill with its versions, recording and keyframes."""

        def write(session: Session) -> bool:
            ws = current_workspace_id()
            row = session.get(SqlTaughtSkill, (ws, skill_id))
            if row is None or row.user_id != user_id:
                return False
            session.execute(
                delete(SqlTaughtSkillVersion).where(
                    SqlTaughtSkillVersion.workspace_id == ws,
                    SqlTaughtSkillVersion.skill_id == skill_id,
                )
            )
            if row.recording_id is not None:
                session.execute(
                    delete(SqlRecordingKeyframe).where(
                        SqlRecordingKeyframe.workspace_id == ws,
                        SqlRecordingKeyframe.recording_id == row.recording_id,
                    )
                )
                session.execute(
                    delete(SqlComputerRecording).where(
                        SqlComputerRecording.workspace_id == ws,
                        SqlComputerRecording.id == row.recording_id,
                    )
                )
            session.delete(row)
            return True

        return run_write_transaction(self._session_immediate, "delete_taught_skill", write)
