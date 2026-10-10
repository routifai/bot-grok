"""Header-auth admin sync: the proxy's ``X-Omnigent-Admin`` becomes ``users.is_admin``."""

from __future__ import annotations

from unittest.mock import MagicMock

from omnigent.server.auth import UnifiedAuthProvider


def _request(headers: dict[str, str]) -> MagicMock:
    request = MagicMock()
    request.headers = headers
    request.scope = {}
    return request


def _provider() -> tuple[UnifiedAuthProvider, list[tuple[str, bool]]]:
    provider = UnifiedAuthProvider(source="header", header_secret="s3cret", local_single_user=False)
    calls: list[tuple[str, bool]] = []
    provider.set_header_admin_sync(lambda user, admin: calls.append((user, admin)))
    return provider, calls


_BASE = {"X-Forwarded-Email": "alice@example.com", "X-Omnigent-Proxy-Secret": "s3cret"}


def test_header_with_secret_promotes() -> None:
    provider, calls = _provider()
    provider.get_user_id(_request({**_BASE, "X-Omnigent-Admin": "1"}))
    assert calls == [("alice@example.com", True)]


def test_header_without_secret_is_ignored() -> None:
    provider, calls = _provider()
    request = _request({"X-Forwarded-Email": "alice@example.com", "X-Omnigent-Admin": "1"})
    assert provider.get_user_id(request) is None
    assert calls == []


def test_wrong_secret_is_ignored() -> None:
    provider, calls = _provider()
    headers = {**_BASE, "X-Omnigent-Proxy-Secret": "nope", "X-Omnigent-Admin": "1"}
    provider.get_user_id(_request(headers))
    assert calls == []


def test_absent_header_demotes_previously_promoted_user() -> None:
    provider, calls = _provider()
    provider.get_user_id(_request({**_BASE, "X-Omnigent-Admin": "1"}))
    provider.get_user_id(_request(dict(_BASE)))
    assert calls == [("alice@example.com", True), ("alice@example.com", False)]


def test_no_write_when_unchanged() -> None:
    provider, calls = _provider()
    for _ in range(3):
        provider.get_user_id(_request({**_BASE, "X-Omnigent-Admin": "1"}))
    assert calls == [("alice@example.com", True)]


def test_failed_write_is_retried_next_request() -> None:
    provider = UnifiedAuthProvider(source="header", header_secret="s3cret", local_single_user=False)
    attempts: list[bool] = []

    def flaky(_user: str, admin: bool) -> None:
        attempts.append(admin)
        if len(attempts) == 1:
            raise RuntimeError("db down")

    provider.set_header_admin_sync(flaky)
    request = _request({**_BASE, "X-Omnigent-Admin": "1"})
    assert provider.get_user_id(request) == "alice@example.com"
    provider.get_user_id(request)
    assert attempts == [True, True]
