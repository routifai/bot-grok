"""
Tests for :mod:`omnigent.resume_dispatch` — the top-level
``omnigent resume`` dispatcher.

The dispatcher translates the user's "take me back to where I was"
intent into a copy-pasteable ``omnigent run --resume`` hint, always
preserving the Omnigent conversation id (no new id minted on resume).
"""

from __future__ import annotations

import click
import httpx
import pytest

from omnigent import resume_dispatch

# ── run_resume — top-level entry ──────────────────────────


def test_run_resume_picker_form_requires_server() -> None:
    """
    ``omnigent resume`` (no conv id, no --server) must fail loud.

    Without ``target`` we'd open the cross-agent picker; without
    ``--server`` we have no Omnigent endpoint to query. Starting an
    empty local server just for the picker would race with any
    other ``omnigent`` process the user has running, so we
    redirect via UsageError instead of silently doing it.
    """
    with pytest.raises(click.UsageError) as excinfo:
        resume_dispatch.run_resume(target=None, server=None)
    # Message names both ways out of the error: a conv id OR --server.
    assert "conv_" in str(excinfo.value)
    assert "--server" in str(excinfo.value)


def test_run_resume_picker_cancel_exits_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Picker returns ``None`` (user pressed q / Enter on empty list) →
    the dispatcher returns cleanly instead of raising a resume hint.
    """
    monkeypatch.setattr(
        resume_dispatch,
        "_pick_conversation_for_resume",
        lambda *, server: None,
    )

    assert resume_dispatch.run_resume(target=None, server="https://example.com") is None


# ── _dispatch_by_runtime — id-known dispatch ──────────────


@pytest.mark.parametrize(
    "pasted",
    [
        "7e52264a6dc51b019fc572f221c81e72.",  # sentence-final period
        "`7e52264a6dc51b019fc572f221c81e72`",  # markdown backticks
        "'7e52264a6dc51b019fc572f221c81e72',",  # quoted list element
        "(7e52264a6dc51b019fc572f221c81e72)",  # parenthesized
    ],
)
def test_dispatch_by_runtime_accepts_id_with_paste_punctuation(pasted: str) -> None:
    """An id pasted with surrounding punctuation resolves to the bare id it contains."""
    with pytest.raises(click.ClickException) as excinfo:
        resume_dispatch._dispatch_by_runtime(target=pasted, server=None)

    msg = excinfo.value.message
    assert "run --resume 7e52264a6dc51b019fc572f221c81e72 <agent.yaml>" in msg


def test_dispatch_by_runtime_malformed_id_raises_short_error() -> None:
    """An argument containing no valid conv id surfaces a short ``ClickException``."""
    with pytest.raises(click.ClickException) as excinfo:
        resume_dispatch._dispatch_by_runtime(target="7e52264a", server=None)

    assert excinfo.value.message == "Invalid session id."


def test_dispatch_by_runtime_legacy_prefixed_id_canonicalized_to_bare_hex() -> None:
    """A legacy ``conv_<hex>`` spelling is canonicalized to bare hex in the hint."""
    with pytest.raises(click.ClickException) as excinfo:
        resume_dispatch._dispatch_by_runtime(
            target="conv_415c9954e2fe4b9276083a4d2c66f689",
            server=None,
        )

    assert "run --resume 415c9954e2fe4b9276083a4d2c66f689 " in excinfo.value.message


def test_dispatch_by_runtime_remote_forwards_non_uuid_id() -> None:
    """
    A remote server owns its id space, so a non-uuid id (e.g. a managed
    deployment's numeric node id) reaches the hint unchanged, with the
    ``--server`` the user passed.
    """
    with pytest.raises(click.ClickException) as excinfo:
        resume_dispatch._dispatch_by_runtime(
            target="2048200000527758",
            server="https://example.com",
        )

    msg = excinfo.value.message
    assert "run --resume 2048200000527758 <agent.yaml> --server https://example.com" in msg


def test_dispatch_by_runtime_local_raises_with_hint() -> None:
    """A local conversation surfaces the ``omnigent run --resume`` hint."""
    with pytest.raises(click.ClickException) as excinfo:
        resume_dispatch._dispatch_by_runtime(
            target="11dc2163ab84c5afa09348998a2b6690",
            server=None,
        )

    msg = excinfo.value.message
    assert "11dc2163ab84c5afa09348998a2b6690" in msg
    assert "omnigent run --resume" in msg
    assert "<agent.yaml>" in msg


# ── _resolve_current_user_id ──────────────────────────────


def test_resolve_current_user_id_returns_user_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Happy path: ``GET /v1/me`` answers 200 with a ``user_id`` → return it.

    The cross-agent picker feeds this to its owner filter so ``omnigent
    resume`` lists only the caller's own sessions.
    """

    def _fake_get(url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        """Return a canned ``GET /v1/me`` identity."""
        del headers, timeout
        assert url.endswith("/v1/me"), url
        return httpx.Response(200, json={"user_id": "alice@example.com", "is_admin": False})

    monkeypatch.setattr(httpx, "get", _fake_get)

    result = resume_dispatch._resolve_current_user_id(
        base_url="https://example.com",
        headers={},
    )
    assert result == "alice@example.com"


def test_resolve_current_user_id_none_when_server_has_no_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A permissionless single-user server answers ``user_id: null`` → ``None``.

    There is no sharing on such a server, so the picker must fall back to
    listing everything (no owner filter) rather than hiding all rows.
    """

    def _fake_get(url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        """Return the unauthenticated-identity shape."""
        del url, headers, timeout
        return httpx.Response(200, json={"user_id": None, "is_admin": False})

    monkeypatch.setattr(httpx, "get", _fake_get)

    result = resume_dispatch._resolve_current_user_id(
        base_url="https://example.com",
        headers={},
    )
    assert result is None


def test_resolve_current_user_id_none_on_non_200(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    A non-200 (e.g. OIDC 401 with a ``login_url``) yields ``None`` — the
    picker lists everything rather than failing. Resume stays usable even
    when identity can't be resolved.
    """

    def _fake_get(url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        """Return a 401 login-required response."""
        del url, headers, timeout
        return httpx.Response(401, json={"user_id": None, "login_url": "/login"})

    monkeypatch.setattr(httpx, "get", _fake_get)

    result = resume_dispatch._resolve_current_user_id(
        base_url="https://example.com",
        headers={},
    )
    assert result is None


def test_resolve_current_user_id_none_on_transport_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """
    A transport failure must NEVER break resume — it degrades to ``None``
    (no owner filter), same as any other unresolved-identity case.
    """

    def _fake_get(url: str, *, headers: dict[str, str], timeout: float) -> httpx.Response:
        """Raise the network error the picker must swallow."""
        del url, headers, timeout
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "get", _fake_get)

    result = resume_dispatch._resolve_current_user_id(
        base_url="https://example.com",
        headers={},
    )
    assert result is None
