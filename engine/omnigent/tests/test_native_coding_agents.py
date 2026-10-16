"""Native coding-agent harness lookups, including reversed-alias folding."""

from __future__ import annotations

from pathlib import Path

import pytest

from omnigent._wrapper_labels import (
    CLAUDE_NATIVE_WRAPPER_VALUE,
    UI_MODE_LABEL_KEY,
    UI_MODE_TERMINAL_VALUE,
    WRAPPER_LABEL_KEY,
)
from omnigent.harness_plugins import CLAUDE_NATIVE_CODING_AGENT
from omnigent.native.native_coding_agents import (
    native_coding_agent_for_harness,
    native_coding_agent_for_wrapper_label,
    native_shell_terminal_spec,
    native_shell_terminal_specs,
    public_agent_name,
)


def test_native_claude_alias_resolves_like_canonical() -> None:
    """``native-claude`` resolves to the same native agent as ``claude-native``.

    ``AgentSpec.harness_kind`` returns the raw ``executor.config.harness``, so
    an agent authored as ``native-claude`` must still resolve — else fork/switch
    would drop its terminal-first presentation labels. ``canonicalize_harness``
    folds the alias before the lookup.
    """
    agent = native_coding_agent_for_harness("native-claude")
    assert agent is CLAUDE_NATIVE_CODING_AGENT
    assert agent is native_coding_agent_for_harness("claude-native")
    assert agent.presentation_labels == {
        UI_MODE_LABEL_KEY: UI_MODE_TERMINAL_VALUE,
        WRAPPER_LABEL_KEY: CLAUDE_NATIVE_WRAPPER_VALUE,
    }


def test_claude_native_agent_metadata() -> None:
    """Claude is the native coding agent, reachable by harness and wrapper label."""
    assert CLAUDE_NATIVE_CODING_AGENT.key == "claude"
    assert CLAUDE_NATIVE_CODING_AGENT.display_name == "Claude"
    assert CLAUDE_NATIVE_CODING_AGENT.agent_name == "claude-native-ui"
    assert CLAUDE_NATIVE_CODING_AGENT.harness == "claude-native"
    assert CLAUDE_NATIVE_CODING_AGENT.terminal_name == "claude"
    assert (
        native_coding_agent_for_wrapper_label(CLAUDE_NATIVE_WRAPPER_VALUE)
        is CLAUDE_NATIVE_CODING_AGENT
    )


def test_unknown_harness_returns_none() -> None:
    """A non-native harness stays unresolved (no terminal presentation)."""
    assert native_coding_agent_for_harness("claude-sdk") is None
    assert native_coding_agent_for_harness(None) is None


def test_public_agent_name_hides_native_ui_wrapper_names() -> None:
    """Native-UI wrapper agent names map to their clean public display name.

    The raw ``<tool>-native-ui`` name is an internal implementation detail; a
    session describing itself (``sys_session_get_info``) must surface the
    display name (e.g. ``Claude``) so the model never repeats
    ``claude-native-ui`` to the user.
    """
    assert public_agent_name("claude-native-ui") == "Claude"


def test_public_agent_name_passes_through_regular_names() -> None:
    """Non-wrapper names (and ``None``) are returned unchanged.

    Regular Omnigent agents have user-meaningful names that are safe to expose,
    so only the native-UI wrappers are rewritten.
    """
    assert public_agent_name("researcher") == "researcher"
    assert public_agent_name("nessie") == "nessie"
    assert public_agent_name("") == ""
    assert public_agent_name(None) is None


@pytest.mark.posix_only
def test_native_shell_terminal_spec_offers_installed_shells_default_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One terminal per installed shell, keyed by name, ``$SHELL`` first.

    Every native wrapper declares this so "+ New shell" opens the user's login
    shell by default while still offering the other installed shells. Each entry
    is keyed and commanded by its basename and is an unsandboxed caller-process
    shell with cwd override allowed.
    """
    monkeypatch.setattr(
        "omnigent.native.native_coding_agents.installed_interactive_shells",
        lambda: ["fish", "bash", "zsh"],
    )
    spec = native_shell_terminal_spec()
    assert list(spec) == ["fish", "bash", "zsh"]
    for name, entry in spec.items():
        assert entry["command"] == name
        assert entry["allow_cwd_override"] is True
        assert entry["os_env"] == {
            "type": "caller_process",
            "cwd": ".",
            "sandbox": {"type": "none"},
        }


def test_native_shell_terminal_spec_falls_back_to_bash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The materialized spec retains discovery's non-empty bash fallback."""
    monkeypatch.setattr(
        "omnigent.native.native_coding_agents.installed_interactive_shells",
        lambda: ["bash"],
    )
    spec = native_shell_terminal_spec()
    assert list(spec) == ["bash"]
    assert spec["bash"]["command"] == "bash"


def test_native_shell_terminal_specs_builds_runtime_specs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A runner can replace the fallback with parsed host terminal specs."""
    monkeypatch.setattr(
        "omnigent._platform._resolve_interactive_shell",
        lambda shell: f"/resolved/{shell}",
    )
    spec = native_shell_terminal_specs(["zsh", "bash"])
    assert list(spec) == ["zsh", "bash"]
    assert spec["zsh"].command == "/resolved/zsh"
    assert spec["zsh"].allow_cwd_override is True
    assert spec["zsh"].os_env != "inherit"
    assert spec["zsh"].os_env is not None
    assert spec["zsh"].os_env.cwd == "."
    assert spec["zsh"].os_env.sandbox is not None
    assert spec["zsh"].os_env.sandbox.type == "none"


@pytest.mark.posix_only
def test_native_shell_terminal_specs_preserves_login_shell_path(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Runtime specs launch a nonstandard absolute login-shell executable."""
    fish = tmp_path / "nix-profile" / "bin" / "fish"
    fish.parent.mkdir(parents=True)
    fish.write_text("#!/bin/sh\n")
    fish.chmod(0o755)
    monkeypatch.setenv("SHELL", str(fish))
    monkeypatch.setattr("shutil.which", lambda _name: None)
    monkeypatch.setattr("omnigent._platform._INTERACTIVE_SHELL_DIRS", ())

    spec = native_shell_terminal_specs(["fish"])

    assert spec["fish"].command == str(fish)
