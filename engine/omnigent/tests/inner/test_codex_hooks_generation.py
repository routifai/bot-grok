from __future__ import annotations

import asyncio
import contextlib
import json
from pathlib import Path
from typing import Any

import pytest

from omnigent.inner import codex_executor
from omnigent.inner.codex_executor import (
    CODEX_EXTENDED_CATALOG_ENV_VAR,
    _CodexAppServerSession,
    _populate_codex_home_config,
    codex_extended_catalog_requested,
    merge_codex_user_hooks,
)

_USER_HOOKS = {
    "hooks": {
        "PreToolUse": [{"hooks": [{"type": "command", "command": "user-pre"}]}],
        "Stop": [{"hooks": [{"type": "command", "command": "user-stop"}]}],
    }
}

# A generated (omnigent-owned) payload, e.g. the policy hooks.
_OMNIGENT_HOOKS: dict[str, Any] = {  # type: ignore[explicit-any]
    "hooks": {
        "PreToolUse": [
            {"matcher": "omnigent-gate", "hooks": [{"type": "command", "command": "gate"}]}
        ],
    }
}

# Enough of a ``codex debug models`` payload for ``extended_model_catalog`` to
# clone the GLM arm from: it needs the clone-source slug to be present.
_MODEL_CATALOG: dict[str, Any] = {  # type: ignore[explicit-any]
    "models": [
        {"slug": "gpt-5.6-luna", "visibility": "list", "supported_reasoning_levels": []},
    ]
}


def _write_user_home(tmp_path: Path, *, hooks: dict[str, object] | None = None) -> Path:
    source = tmp_path / "user-codex"
    source.mkdir()
    (source / "auth.json").write_text("{}")
    (source / "config.toml").write_text('model = "gpt-5.4-mini"\n')
    if hooks is not None:
        (source / "hooks.json").write_text(json.dumps(hooks))
    return source


def test_merge_user_hooks_preserves_user_entries_after_omnigent(tmp_path: Path) -> None:
    user_hooks = tmp_path / "hooks.json"
    user_hooks.write_text(json.dumps(_USER_HOOKS))
    payload = json.loads(json.dumps(_OMNIGENT_HOOKS))

    merged = merge_codex_user_hooks(payload, user_hooks)

    pre = merged["hooks"]["PreToolUse"]
    assert len(pre) == 2
    assert pre[0]["matcher"] == "omnigent-gate"
    assert pre[1]["hooks"][0]["command"] == "user-pre"
    assert merged["hooks"]["Stop"][0]["hooks"][0]["command"] == "user-stop"
    # The original payload is not mutated.
    assert len(payload["hooks"]["PreToolUse"]) == 1


def test_merge_user_hooks_tolerates_malformed_user_file(tmp_path: Path) -> None:
    user_hooks = tmp_path / "hooks.json"
    user_hooks.write_text("{not json")
    assert merge_codex_user_hooks(_OMNIGENT_HOOKS, user_hooks) == _OMNIGENT_HOOKS


def test_populate_symlinks_hooks_when_none_are_injected(tmp_path: Path) -> None:
    source = _write_user_home(tmp_path, hooks=_USER_HOOKS)
    codex_home = tmp_path / "private"
    codex_home.mkdir()

    _populate_codex_home_config(codex_home, source)

    assert (codex_home / "hooks.json").is_symlink()
    assert (codex_home / "hooks.json").resolve() == (source / "hooks.json").resolve()


def test_the_launch_signal_survives_the_codex_env_filter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The executor reads its session class out of the FILTERED env.

    ``_clean_codex_env`` is both the codex subprocess env and the executor's
    own view of its launch, so a signal missing from its allowlist is dropped
    and the feature it gates silently never engages — the extended catalog
    was unreachable on the wrapped ``codex`` harness.
    """
    monkeypatch.setenv(CODEX_EXTENDED_CATALOG_ENV_VAR, "1")

    filtered = codex_executor._clean_codex_env()

    assert codex_extended_catalog_requested(filtered) is True


class _HomeSnapshot:
    """The private ``CODEX_HOME`` as codex would have read it at launch."""

    def __init__(self, home: Path) -> None:
        hooks = home / "hooks.json"
        self.is_symlink = hooks.is_symlink()
        self.payload: dict[str, Any] | None = None  # type: ignore[explicit-any]
        if hooks.is_file():
            self.payload = json.loads(hooks.read_text())
        self.catalog_written = (home / "model_catalog.json").is_file()
        config = home / "config.toml"
        self.config_names_catalog = config.is_file() and "model_catalog_json" in config.read_text(
            encoding="utf-8"
        )


def _start_app_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    env: dict[str, str],
    probes: list[str] | None = None,
) -> tuple[tuple[str, ...], _HomeSnapshot]:
    source = _write_user_home(tmp_path, hooks=_USER_HOOKS)
    workspace = tmp_path / "work"
    workspace.mkdir()
    captured: list[tuple[tuple[str, ...], _HomeSnapshot]] = []

    async def fake_exec(*argv: str, **kwargs: Any) -> Any:  # type: ignore[explicit-any]
        # The session deletes its private CODEX_HOME on the launch failure
        # below, so snapshot the home while codex would have read it.
        home = Path(kwargs["env"]["CODEX_HOME"])
        captured.append((argv, _HomeSnapshot(home)))
        raise RuntimeError("stop")

    def fake_probe(codex_path: str, source_home: Path, *, timeout: float) -> dict[str, Any]:  # type: ignore[explicit-any]
        del source_home, timeout
        if probes is not None:
            probes.append(codex_path)
        return _MODEL_CATALOG

    monkeypatch.setattr(codex_executor, "populate_codex_skills_from_bundle", lambda *a, **k: None)
    monkeypatch.setattr(codex_executor, "_codex_home_config_source_from_env", lambda: source)
    monkeypatch.setattr(codex_executor, "_create_subprocess_exec", fake_exec)
    # Never shell out to a real ``codex debug models`` from a unit test, and
    # never let one session's cached catalog answer another's probe count.
    monkeypatch.setattr(codex_executor, "_find_codex_cli", lambda: "/bin/codex")
    monkeypatch.setattr(codex_executor, "_MODEL_CATALOG_CACHE", {})
    monkeypatch.setattr(codex_executor, "_MODEL_CATALOG_FAILURES", {})
    monkeypatch.setattr(codex_executor, "_probe_codex_model_catalog", fake_probe)
    session = _CodexAppServerSession(
        codex_path="/bin/echo",
        cwd=str(workspace),
        env=env,
        tool_executor=None,
    )
    with contextlib.suppress(RuntimeError):
        asyncio.run(session.start())
    assert captured, "the app-server was never launched"
    return captured[0]


# ── The codex session classes (SDK arm) ─────────────────────────────
#
# A plain codex session must look exactly like a pre-Smart-Routing one: no
# ``codex debug models`` probe replacing its model catalog, no generated
# ``hooks.json``, and the user's own hooks.json still symlinked so a
# mid-session edit takes effect. A pinned Smart Routing session adds the
# catalog and nothing else — its routed turn can land on a gateway arm
# codex's bundled catalog has no entry for.


def test_a_plain_codex_session_gets_no_probe_and_keeps_its_hooks_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    probes: list[str] = []

    _argv, home = _start_app_server(tmp_path, monkeypatch, env={}, probes=probes)

    assert probes == []
    assert not home.catalog_written
    assert not home.config_names_catalog
    assert home.is_symlink
    # The file codex reads is the user's own, byte for byte.
    assert home.payload == _USER_HOOKS


def test_a_pinned_smart_routing_codex_session_gets_the_catalog_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    probes: list[str] = []

    _argv, home = _start_app_server(
        tmp_path,
        monkeypatch,
        env={CODEX_EXTENDED_CATALOG_ENV_VAR: "1"},
        probes=probes,
    )

    assert probes == ["/bin/codex"]
    assert home.catalog_written
    assert home.config_names_catalog
    # No hooks were injected, so the user's file is still the live one.
    assert home.is_symlink
    assert home.payload == _USER_HOOKS
