"""``/v1/me/model-credential``: sealed per-user provider key, masked on the wire, offline."""

from __future__ import annotations

import base64
import logging
import os
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.db.db_models import OmnigentBase
from omnigent.db.utils import get_or_create_engine
from omnigent.errors import OmnigentError
from omnigent.model_credentials.routes import create_model_credential_router
from omnigent.model_credentials.store import ModelCredentialStore, get_owner_model_credential
from omnigent.superchat.vault.store import (
    VAULT_KEY_ENV,
    VaultUnavailableError,
    seal,
    unseal,
)

KEY = "sk-ant-api03-SECRETSECRET-wxyz"


class _Auth:
    """The caller is whoever the X-User header names."""

    def get_user_id(self, request: Request) -> str:
        return request.headers.get("x-user", "u1")


class _Probe:
    """Offline transport: records requests, answers a fixed status or raises."""

    def __init__(self, status: int = 200, error: Exception | None = None) -> None:
        self.status, self.error, self.requests = status, error, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.error:
            raise self.error
        return httpx.Response(self.status, json={})


def _app(uri: str, probe: _Probe) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_model_credential_router(
            ModelCredentialStore(uri),
            auth_provider=_Auth(),  # type: ignore[arg-type]
            transport=httpx.MockTransport(probe),
        ),
        prefix="/v1",
    )

    @app.exception_handler(OmnigentError)
    async def _err(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": {"message": str(exc)}}, status_code=exc.http_status)

    return TestClient(app)


@pytest.fixture
def uri(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setenv(VAULT_KEY_ENV, base64.b64encode(os.urandom(32)).decode())
    u = f"sqlite:///{tmp_path / 'c.db'}"
    OmnigentBase.metadata.create_all(get_or_create_engine(u))
    return u


def test_seal_round_trip_binds_user_and_provider(uri: str) -> None:
    token = seal(KEY, user_id="u1", secret_id="anthropic")
    assert KEY not in token
    assert unseal(token, user_id="u1", secret_id="anthropic") == KEY
    with pytest.raises(VaultUnavailableError):
        unseal(token, user_id="u2", secret_id="anthropic")
    with pytest.raises(VaultUnavailableError):
        unseal(token, user_id="u1", secret_id="openrouter")


def test_fails_closed_without_vault_key(uri: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(VAULT_KEY_ENV)
    probe = _Probe()
    client = _app(uri, probe)
    r = client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    assert r.status_code == 503
    assert KEY not in r.text
    assert client.get("/v1/me/model-credential").status_code == 404


def test_put_stores_masked_and_get_returns_hint_only(uri: str) -> None:
    probe = _Probe()
    client = _app(uri, probe)
    r = client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    assert r.status_code == 200
    body = r.json()
    assert body["provider"] == "anthropic" and body["hint"] == "wxyz"
    assert body["status"] == "valid" and body["validated_at"] > 0
    req = probe.requests[0]
    assert str(req.url) == "https://api.anthropic.com/v1/models"
    assert req.headers["x-api-key"] == KEY and req.headers["anthropic-version"] == "2023-06-01"
    got = client.get("/v1/me/model-credential")
    assert got.json() == body and KEY not in got.text
    store = ModelCredentialStore(uri)
    assert get_owner_model_credential(store, "u1") == ("anthropic", KEY)
    # one key per user: a second PUT replaces it
    client.put(
        "/v1/me/model-credential", json={"provider": "openrouter", "api_key": "or-key-1234"}
    )
    assert probe.requests[-1].headers["authorization"] == "Bearer or-key-1234"
    assert str(probe.requests[-1].url) == "https://openrouter.ai/api/v1/key"
    assert get_owner_model_credential(store, "u1") == ("openrouter", "or-key-1234")


@pytest.mark.parametrize("status", [401, 403])
def test_rejected_key_is_not_stored(uri: str, status: int) -> None:
    client = _app(uri, _Probe(status))
    r = client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    assert r.status_code == 400
    assert "This key was not accepted by Anthropic" in r.text and KEY not in r.text
    assert client.get("/v1/me/model-credential").status_code == 404


def test_network_error_is_distinct(uri: str) -> None:
    client = _app(uri, _Probe(error=httpx.ConnectError(f"boom {KEY}")))
    r = client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    assert r.status_code == 502
    assert "Could not reach Anthropic" in r.text and KEY not in r.text
    assert client.get("/v1/me/model-credential").status_code == 404


def test_bad_input(uri: str) -> None:
    client = _app(uri, _Probe())
    assert (
        client.put("/v1/me/model-credential", json={"provider": "x", "api_key": KEY}).status_code
        == 400
    )
    r = client.put("/v1/me/model-credential", json={"api_key": KEY})
    assert r.status_code == 400 and KEY not in r.text
    r = client.put(
        "/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY, "x": 1}
    )
    assert r.status_code == 422 and KEY not in r.text


def test_delete_and_other_user_isolation(uri: str) -> None:
    client = _app(uri, _Probe())
    client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    other = {"x-user": "u2"}
    assert client.get("/v1/me/model-credential", headers=other).status_code == 404
    assert client.delete("/v1/me/model-credential", headers=other).status_code == 404
    assert client.get("/v1/me/model-credential").status_code == 200
    assert get_owner_model_credential(ModelCredentialStore(uri), "u2") is None
    assert client.delete("/v1/me/model-credential").status_code == 204
    assert client.get("/v1/me/model-credential").status_code == 404


def test_plaintext_never_in_logs_or_db(uri: str, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    client = _app(uri, _Probe(401))
    client.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    client2 = _app(uri, _Probe())
    client2.put("/v1/me/model-credential", json={"provider": "anthropic", "api_key": KEY})
    client2.get("/v1/me/model-credential")
    assert KEY not in caplog.text
    import sqlalchemy as sa

    with get_or_create_engine(uri).connect() as conn:
        rows = conn.execute(sa.text("select * from user_model_credential")).fetchall()
    assert rows and KEY not in repr(rows)
