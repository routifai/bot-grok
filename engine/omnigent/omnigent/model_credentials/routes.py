"""``/v1/me/model-credential``: the caller's own provider API key (bring your own key).

``GET`` returns ``{provider, hint, validated_at, status}`` or 404. ``PUT {provider, api_key}``
probes the key with the provider, seals and stores it, and returns the same masked metadata.
``DELETE`` removes it. The key is never echoed, returned or logged: the body model keeps it out
of ``repr`` and carries no validators (so a validation error cannot quote it), and errors name
only the provider.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.model_credentials.probe import (
    PROVIDERS,
    KeyRejectedError,
    ProbeUnavailableError,
    probe_key,
)
from omnigent.model_credentials.store import (
    CredentialInputError,
    CredentialMeta,
    ModelCredentialStore,
)
from omnigent.server.auth import RESERVED_USER_LOCAL, AuthProvider
from omnigent.server.routes._auth_helpers import require_user
from omnigent.superchat.vault.store import VaultUnavailableError


class PutModelCredential(BaseModel):
    """Body of ``PUT /v1/me/model-credential``."""

    model_config = ConfigDict(extra="forbid")

    # Defaults, not required fields: a "missing field" 422 would quote the whole body.
    provider: str = ""
    api_key: str = Field("", repr=False)


def meta_to_response(meta: CredentialMeta) -> dict[str, Any]:
    """Masked metadata only: never the key."""
    return {
        "provider": meta.provider,
        "hint": meta.hint,
        "validated_at": meta.validated_at,
        "status": meta.status,
    }


def create_model_credential_router(
    store: ModelCredentialStore,
    *,
    auth_provider: AuthProvider | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> APIRouter:
    """Build the router, mounted with ``prefix="/v1"``. *transport* makes the probe injectable."""
    router = APIRouter()

    def _owner(request: Request) -> str:
        return require_user(request, auth_provider) or RESERVED_USER_LOCAL

    @router.get("/me/model-credential")
    async def get_credential(request: Request) -> dict[str, Any]:
        """The caller's saved key as masked metadata, or 404."""
        meta = await asyncio.to_thread(store.get_meta, _owner(request))
        if meta is None:
            raise OmnigentError("No model credential saved", code=ErrorCode.NOT_FOUND)
        return meta_to_response(meta)

    @router.put("/me/model-credential")
    async def put_credential(request: Request, body: PutModelCredential) -> dict[str, Any]:
        """Probe the key with its provider, then store it sealed (replacing any previous one)."""
        owner = _owner(request)
        if body.provider not in PROVIDERS:
            raise OmnigentError(
                "provider must be 'anthropic' or 'openrouter'", code=ErrorCode.INVALID_INPUT
            )
        api_key = body.api_key.strip()
        if not api_key:
            raise OmnigentError("api_key is required", code=ErrorCode.INVALID_INPUT)
        try:
            await probe_key(body.provider, api_key, transport=transport)
        except KeyRejectedError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from None
        except ProbeUnavailableError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.RUNNER_UNAVAILABLE) from None
        try:
            meta = await asyncio.to_thread(store.put, owner, body.provider, api_key)
        except VaultUnavailableError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.FORBIDDEN) from None
        except CredentialInputError as exc:
            raise OmnigentError(str(exc), code=ErrorCode.INVALID_INPUT) from None
        return meta_to_response(meta)

    @router.delete("/me/model-credential", status_code=204)
    async def delete_credential(request: Request) -> Response:
        """Remove the caller's saved key."""
        if not await asyncio.to_thread(store.delete, _owner(request)):
            raise OmnigentError("No model credential saved", code=ErrorCode.NOT_FOUND)
        return Response(status_code=204)

    return router
