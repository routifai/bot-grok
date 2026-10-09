"""The file index migration creates both tables, matches the models, and rolls back."""

from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from omnigent.db.db_models import SqlFileChunk, SqlFileIndexJob
from omnigent.db.utils import _build_alembic_config, get_or_create_engine

REVISION = "kn1b2c3d4e5f"


def test_file_index_migration_is_the_head_and_round_trips(tmp_path: Path) -> None:
    uri = f"sqlite:///{tmp_path / 'index.db'}"
    engine = get_or_create_engine(uri)
    config = _build_alembic_config(uri)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        assert ScriptDirectory.from_config(config).get_heads() == [REVISION]
    inspector = sa.inspect(engine)
    for model in (SqlFileIndexJob, SqlFileChunk):
        table = model.__table__
        columns = {c["name"] for c in inspector.get_columns(table.name)}
        assert columns == {c.name for c in table.columns}
        assert {i["name"] for i in inspector.get_indexes(table.name)} == {
            i.name for i in table.indexes
        }
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, "vf1b2c3d4e5f")
    tables = sa.inspect(engine).get_table_names()
    assert "file_index_jobs" not in tables and "file_chunks" not in tables
    assert "artifact_publications" in tables
