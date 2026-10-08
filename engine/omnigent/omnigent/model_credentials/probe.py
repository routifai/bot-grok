"""Validate a provider API key with one cheap authenticated GET; the key is never logged."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

PROVIDERS = ("anthropic", "openrouter")
_LABELS = {"anthropic": "Anthropic", "openrouter": "OpenRouter"}
_TIMEOUT_SECONDS = 10.0


class KeyRejectedError(Exception):
    """The provider answered 401/403: the key is not valid."""


class ProbeUnavailableError(Exception):
    """The provider could not be reached or answered something unexpected."""


@dataclass(frozen=True)
class _Probe:
    url: str
    headers: dict[str, str]


def provider_label(provider: str) -> str:
    """:returns: The display name of provider."""
    return _LABELS[provider]


def _probe(provider: str, api_key: str) -> _Probe:
    if provider == "anthropic":
        return _Probe(
            "https://api.anthropic.com/v1/models",
            {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        )
    return _Probe("https://openrouter.ai/api/v1/key", {"Authorization": f"Bearer {api_key}"})


async def probe_key(
    provider: str, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None
) -> None:
    """Return when the provider accepts the key.

    :param transport: Injectable httpx transport (tests are offline).
    :raises KeyRejectedError: 401/403.
    :raises ProbeUnavailableError: network error, timeout or any other status.
    """
    probe = _probe(provider, api_key)
    label = provider_label(provider)
    try:
        async with httpx.AsyncClient(
            transport=transport, timeout=_TIMEOUT_SECONDS, follow_redirects=False
        ) as client:
            response = await client.get(probe.url, headers=probe.headers)
    except httpx.HTTPError as exc:
        # Only the exception type is kept: its text could carry request details.
        raise ProbeUnavailableError(
            f"Could not reach {label} to check the key ({type(exc).__name__}); try again"
        ) from None
    if response.status_code in (401, 403):
        raise KeyRejectedError(f"This key was not accepted by {label}")
    if response.status_code != 200:
        raise ProbeUnavailableError(
            f"{label} could not check the key right now (HTTP {response.status_code}); try again"
        )
