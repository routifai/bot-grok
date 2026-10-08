"""Engine-side model proxy: a Computer's model calls are made with its owner's key.

The agent can run shell commands inside its Computer, so any key placed in that Computer's env or
files is readable by it. Instead the Computer's harness points its model base URL at this route and
presents a *credential* that is only the Computer's own launch token (``<host_id>:<token>``, the
same token the host tunnel and :mod:`omnigent.server.routes.host_credentials` use). The route
resolves token -> host -> owner server-side, looks up the owner's sealed key, strips whatever auth
the caller sent, injects the owner's key and streams the provider's answer back. The key never
leaves the engine process.

Route: ``/v1/model/{provider}/{path}``. There is no host id in the path: the base URL is fixed in
the session snapshot before the Computer exists, so the host id travels inside the credential.
``provider`` is an upstream from :mod:`omnigent.model_credentials.upstreams` (base URL and auth
style come from there) and is resolved to the owner's connection for exactly that provider: their
own key first, else the organization's. Auth headers and
bodies are never logged.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException, Request
from starlette.responses import StreamingResponse

from omnigent.errors import ErrorCode, OmnigentError
from omnigent.model_credentials.store import resolve_model_connection
from omnigent.model_credentials.upstreams import UPSTREAMS
from omnigent.stores.host_store import HostStore

_logger = logging.getLogger(__name__)

KEY_REQUIRED_MESSAGE = "Add your Anthropic or OpenRouter API key in Settings to use Nova."
# connect/write/pool are short; a long read covers a model that thinks silently for minutes.
_TIMEOUT = httpx.Timeout(connect=10.0, read=900.0, write=60.0, pool=10.0)
# Request headers never forwarded: the caller's auth, hop-by-hop and transport framing.
_DROP_REQUEST = frozenset(
    {
        "authorization",
        "x-api-key",
        "host",
        "content-length",
        "connection",
        "accept-encoding",
        "cookie",
        "x-omnigent-host-token",
        "transfer-encoding",
    }
)
_DROP_RESPONSE = frozenset(
    {"content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"}
)


def split_credential(request: Request) -> tuple[str, str] | None:
    """:returns: ``(host_id, token)`` from ``x-api-key`` or a Bearer header, or ``None``."""
    value = request.headers.get("x-api-key")
    if not value:
        auth = request.headers.get("authorization", "")
        value = auth[7:] if auth.lower().startswith("bearer ") else ""
    host_id, sep, token = value.strip().partition(":")
    if not sep or not host_id or not token:
        return None
    return host_id, token


def create_model_proxy_router(
    host_store: HostStore, *, transport: httpx.AsyncBaseTransport | None = None
) -> APIRouter:
    """Build the router, mounted with ``prefix="/v1"``. *transport* makes upstream injectable."""
    router = APIRouter()

    @router.api_route("/model/{provider}/{path:path}", methods=["GET", "POST"])
    async def model_proxy(provider: str, path: str, request: Request) -> StreamingResponse:
        """Forward a model call with the session owner's key; stream the answer back."""
        credential = split_credential(request)
        if credential is None:
            raise HTTPException(status_code=401, detail="missing host credential")
        managed = await asyncio.to_thread(host_store.resolve_launch_token, *credential)
        if managed is None:
            raise HTTPException(status_code=401, detail="unauthenticated")
        upstream_cfg = UPSTREAMS.get(provider)
        segments = path.split("/")
        if upstream_cfg is None or segments[0] != "v1" or ".." in segments or "" in segments:
            raise HTTPException(status_code=404, detail="unknown model route")
        store = getattr(request.app.state, "model_connection_store", None)
        connection = (
            await asyncio.to_thread(
                resolve_model_connection, store, owner_id=managed.user_id, preferred=(provider,)
            )
            if store is not None
            else None
        )
        if connection is None:
            raise OmnigentError(KEY_REQUIRED_MESSAGE, code=ErrorCode.MODEL_KEY_REQUIRED)
        headers = {
            name: value
            for name, value in request.headers.items()
            if name.lower() not in _DROP_REQUEST
        }
        headers.update(upstream_cfg.key_header(connection.plaintext))
        client = httpx.AsyncClient(transport=transport, timeout=_TIMEOUT, follow_redirects=False)
        upstream_request = client.build_request(
            request.method,
            f"{upstream_cfg.base_url}/{path}",
            params=request.query_params,
            headers=headers,
            content=await request.body(),
        )
        try:
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as exc:
            await client.aclose()
            # Only the exception type is logged: its text could carry request details.
            _logger.warning("model proxy: %s unreachable (%s)", provider, type(exc).__name__)
            raise OmnigentError(
                f"Could not reach {provider}.", code=ErrorCode.MODEL_PROVIDER_UNREACHABLE
            ) from None

        async def body() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()

        return StreamingResponse(
            body(),
            status_code=upstream.status_code,
            headers={
                name: value
                for name, value in upstream.headers.items()
                if name.lower() not in _DROP_RESPONSE
            },
        )

    return router
