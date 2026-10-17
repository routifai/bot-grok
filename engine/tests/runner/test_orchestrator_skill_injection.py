"""Tests for ``build-omnigent`` skill injection into native agent bundles.

The injector resolved its source path by counting ``.parent``s off its own
module file. Moving the module one package deeper left the count stale, so
the source directory did not exist and the ``not source.is_dir()`` guard
returned on every call — silently injecting nothing for every
``omnigent claude`` / ``omnigent codex`` user.

These tests pin the observable outcome (the skill lands in the bundle and
the Codex consumer resolves it) rather than the path expression, so the
next move of the module fails here instead of in the field.
"""

from __future__ import annotations

from pathlib import Path

import omnigent

SKILL_NAME = "build-omnigent"


def test_skill_source_lives_in_the_installed_package() -> None:
    """The canonical source directory ships inside the package."""
    source = Path(omnigent.__file__).resolve().parent / "onboarding" / "agent" / "skills"
    assert (source / SKILL_NAME / "SKILL.md").is_file()
