"""Tests for native-wrapper resume hint formatting."""

from __future__ import annotations

import pytest

from omnigent.native._native_resume_hint import format_native_resume_command


def test_format_native_resume_command_includes_remote_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    Remote native-wrapper hints include enough context to copy/paste.

    The command must carry the wrapper name, Omnigent server, and
    Omnigent conversation id. If any of those fields are dropped, a
    user who launched against a non-default remote workspace cannot
    reliably resume the same conversation from the printed hint.
    There is no ``--profile`` part: the CLI flag was removed, so a
    hint containing it would tell the user to run a command that
    no longer parses.
    """
    monkeypatch.delenv("OMNIGENT_RESUME_COMMAND_PREFIX", raising=False)

    command = format_native_resume_command(
        native_command="claude",
        server="https://example.databricks.com",
        session_id="conv_abc",
    )

    assert command == ("omnigent claude --server https://example.databricks.com --resume conv_abc")


def test_format_native_resume_command_uses_launcher_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A distribution wrapper can replace the executable and own routing."""
    monkeypatch.setenv("OMNIGENT_RESUME_COMMAND_PREFIX", "acme-agent omnigent")

    command = format_native_resume_command(
        native_command="codex",
        server="https://example.com/omnigent",
        session_id="conv_abc",
    )

    assert command == "acme-agent omnigent codex --resume conv_abc"
    assert "--server" not in command


def test_format_native_resume_command_shell_quotes_prefixed_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Prefix arguments and dynamic values remain safe to paste into a shell."""
    monkeypatch.setenv(
        "OMNIGENT_RESUME_COMMAND_PREFIX",
        "acme-agent --profile 'example team' omnigent",
    )

    command = format_native_resume_command(
        native_command="claude",
        session_id="conversation with spaces",
    )

    assert command == (
        "acme-agent --profile 'example team' omnigent claude --resume 'conversation with spaces'"
    )


@pytest.mark.parametrize(
    "prefix",
    ["   ", "acme-agent 'unterminated"],
    ids=["whitespace-only", "malformed"],
)
def test_format_native_resume_command_ignores_invalid_prefix(
    monkeypatch: pytest.MonkeyPatch,
    prefix: str,
) -> None:
    """An invalid launcher prefix falls back to the default resume command."""
    monkeypatch.setenv("OMNIGENT_RESUME_COMMAND_PREFIX", prefix)

    command = format_native_resume_command(
        native_command="codex",
        server="https://example.com/omnigent",
        session_id="conv_abc",
    )

    assert command == ("omnigent codex --server https://example.com/omnigent --resume conv_abc")
