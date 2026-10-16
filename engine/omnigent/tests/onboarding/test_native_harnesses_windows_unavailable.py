"""Windows harness-readiness regressions."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import omnigent.onboarding.harness_install as hi
import omnigent.onboarding.harness_readiness as readiness
from omnigent.harness_aliases import NATIVE_HARNESSES


@pytest.fixture(autouse=True)
def _isolate_credentials(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OMNIGENT_CONFIG_HOME", str(tmp_path))

    import omnigent._platform as _plat

    monkeypatch.delenv("OMNIGENT_CODEX_PATH", raising=False)
    monkeypatch.setattr(_plat, "_cli_fallback_dirs", lambda: ())


def _all_clis_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hi.shutil, "which", lambda name: f"/usr/bin/{name}")

    def _stub_run(argv: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if len(argv) >= 2 and argv[1] == "--version":
            return subprocess.CompletedProcess(
                args=argv, returncode=0, stdout="9.9.9\n", stderr=""
            )
        raise AssertionError(f"unexpected subprocess in readiness tests: {argv!r}")

    monkeypatch.setattr(hi.subprocess, "run", _stub_run)
    monkeypatch.setattr(hi, "harness_cli_logged_in", lambda _key, **_kw: True)


@pytest.mark.parametrize("harness", sorted(NATIVE_HARNESSES))
def test_native_terminal_harness_unavailable_on_windows(
    monkeypatch: pytest.MonkeyPatch,
    harness: str,
) -> None:
    _all_clis_installed(monkeypatch)
    import omnigent._platform as _plat

    monkeypatch.setattr(_plat, "IS_WINDOWS", True)
    monkeypatch.setattr(readiness, "IS_WINDOWS", True)

    result = readiness.configured_harness_map()

    assert result.get(harness) is not True


def test_sdk_harnesses_remain_available_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _all_clis_installed(monkeypatch)
    import omnigent._platform as _plat

    monkeypatch.setattr(_plat, "IS_WINDOWS", True)
    monkeypatch.setattr(readiness, "IS_WINDOWS", True)
    # SDK readiness is credential-based (True only when a locally visible
    # credential source could serve the harness, else "needs-auth"), so give
    # it an ambient key: this test asserts the *Windows gate* never knocks the
    # in-process SDK harness out, not that it is ready on a credential-less host.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-windows-test")

    result = readiness.configured_harness_map()

    for sdk_harness in ("claude-sdk", "claude_sdk", "claude"):
        assert result.get(sdk_harness) is True
