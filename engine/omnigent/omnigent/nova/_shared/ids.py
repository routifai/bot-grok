"""Row ids and timestamps, in Omnigent's database conventions."""

from __future__ import annotations

import time
import uuid


def new_id() -> str:
    """A fresh 32-character hex id, the format Omnigent's ``Uuid16`` columns use."""
    return uuid.uuid4().hex


def now_s() -> int:
    """The current time in Unix epoch seconds."""
    return int(time.time())
