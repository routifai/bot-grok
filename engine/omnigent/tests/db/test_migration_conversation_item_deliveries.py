"""The migration that adds ``conversation_item_deliveries``, and rolls back without it."""

from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.script import ScriptDirectory

from omnigent.db.utils import _build_alembic_config, get_or_create_engine

PREVIOUS = "kn2b3c4d5e6f"
REVISION = "kn3b4c5d6e7f"
TABLE = "conversation_item_deliveries"


def test_item_deliveries_migration_is_the_head_and_round_trips(tmp_path: Path) -> None:
    uri = f"sqlite:///{tmp_path / 'deliveries.db'}"
    engine = get_or_create_engine(uri)
    config = _build_alembic_config(uri)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        assert ScriptDirectory.from_config(config).get_heads() == [REVISION]
    inspector = sa.inspect(engine)
    assert TABLE in inspector.get_table_names()
    assert inspector.get_pk_constraint(TABLE)["constrained_columns"] == [
        "workspace_id",
        "conversation_id",
        "item_id",
    ]

    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.downgrade(config, PREVIOUS)
    assert TABLE not in sa.inspect(engine).get_table_names()
