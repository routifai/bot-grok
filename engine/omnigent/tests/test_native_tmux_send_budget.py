"""The claude-native bridge's per-command tmux send budget covers a boot-load stall.

The bridge shells out to ``tmux`` for keystroke delivery with a flat
per-command subprocess timeout. Parallel worker boots on a large worktree can
starve a healthy tmux server past 5s, and a budget at or below that fails the
first dispatch send of the worker on infra (or silently loses it, stranding
the supervisor).
"""

from __future__ import annotations

from omnigent.harnesses.claude_native import bridge as claude_native_bridge


def test_tmux_send_budget_covers_a_boot_load_stall() -> None:
    """The budget rides out a realistic parallel-boot server stall.

    Parallel native-worker boots on a large worktree have been observed to
    starve a healthy tmux server for ~7s; a budget at or below that kills the
    first dispatch send of every worker that boots under load.
    """
    assert claude_native_bridge._TMUX_SEND_TIMEOUT_S >= 10.0
