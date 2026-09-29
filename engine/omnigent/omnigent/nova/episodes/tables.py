"""SQLAlchemy model for ``nova_episodes``."""

from __future__ import annotations

from sqlalchemy import BigInteger, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from omnigent.db.db_models import OmnigentBase, Uuid16, current_workspace_id


class SqlNovaEpisode(OmnigentBase):
    """One recorded episode row.

    See the migration (``omnigent/db/migrations/versions/nova02episodes_*``)
    for column-size reasoning and indexes. ``tools`` and ``links`` are compact
    JSON arrays (encoded/decoded in ``sqlalchemy_store.py``), each bounded to a
    small fixed item count and per-item length before every write.

    :param workspace_id: Tenant partition; part of the primary key.
    :param id: Uuid16 primary key (bare 32-char hex in Python).
    :param user_id: The owning person.
    :param session_id: The session the turn ran in.
    :param turn_id: The turn's response id; unique with ``session_id`` per
        workspace so recording is idempotent.
    :param title: Short title, from the person's request.
    :param summary: Plain-text summary, from Nova's reply.
    :param tools: JSON array of distinct tool names, sorted.
    :param links: JSON array of distinct http(s) links, in order.
    :param created_at: Unix epoch seconds at first recording.
    :param updated_at: Unix epoch seconds of the last re-recording, or
        ``None``.
    """

    __tablename__ = "nova_episodes"

    workspace_id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        nullable=False,
        server_default="0",
        default=current_workspace_id,
    )
    id: Mapped[str] = mapped_column(Uuid16(), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[str] = mapped_column(String(64), nullable=False)
    turn_id: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    summary: Mapped[str] = mapped_column(String(1536), nullable=False)
    tools: Mapped[str] = mapped_column(String(1536), nullable=False)
    links: Mapped[str] = mapped_column(String(2560), nullable=False)
    created_at: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_at: Mapped[int | None] = mapped_column(Integer, nullable=True)
