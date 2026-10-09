"""Computer screen routes: see the sandbox screen, take it over, hand it back.

Layout: ``routes`` (``/sessions/{id}/computer*``, mounted on the sessions router), ``target``
(which screen a session sits on). ``skills`` builds on this capability (recording what the person
does on the screen), through the names exported here only.
"""

from __future__ import annotations

from omnigent.superchat.computer.target import require_target, screen_target

__all__ = ["require_target", "screen_target"]
