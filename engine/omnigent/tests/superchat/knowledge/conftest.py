"""Knowledge tests: artifact events are process-wide, so each test starts and ends with none."""

from __future__ import annotations

import os

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

import pytest

from omnigent.superchat.artifacts import unsubscribe_all


@pytest.fixture(autouse=True)
def _no_artifact_listeners():
    unsubscribe_all()
    yield
    unsubscribe_all()
