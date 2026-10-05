"""Approvals: standing rules, spending cap and pending prompts for actions in the person's name.

Layout: ``policy`` (risk classification + the ``muse_approvals`` engine policy), ``store``
(SQLAlchemy rules / pending store), ``routes`` (``/v1/approvals``), ``feature`` (registration).
Imports stay lazy so importing a submodule never loads the server.
"""

from __future__ import annotations

from omnigent.superchat.approvals.feature import FEATURE

__all__ = ["FEATURE"]
