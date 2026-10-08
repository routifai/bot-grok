"""The provider registry: one table describing every model upstream the engine can call.

The probe (key validation), the model proxy (where a call goes and how it is authenticated) and
the connection routes (which providers exist) all read this table; nothing else hardcodes a
provider. ``vendors_served`` and ``wire_apis`` are the facts later slices filter on (which model
vendors a harness can reach through an upstream, and over which wire protocol).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

AuthStyle = Literal["x-api-key", "bearer"]


@dataclass(frozen=True)
class Upstream:
    """One model upstream.

    :param name: Registry key, also the ``{provider}`` segment of the proxy route.
    :param label: Display name used in messages.
    :param base_url: Origin (plus any fixed prefix) the proxy forwards ``/v1/...`` paths onto.
    :param auth: How the key is sent: an ``x-api-key`` header or ``Authorization: Bearer``.
    :param wire_apis: Wire protocols served: ``messages`` (Anthropic), ``chat`` (OpenAI Chat
        Completions), later ``responses``.
    :param vendors_served: ``claude`` (only Anthropic models) or ``any``.
    :param probe_path: Cheap authenticated GET under ``base_url`` that answers 200 for a good key.
    :param extra_headers: Static headers every request to this upstream needs.
    """

    name: str
    label: str
    base_url: str
    auth: AuthStyle
    wire_apis: frozenset[str]
    vendors_served: Literal["claude", "any"]
    probe_path: str
    extra_headers: tuple[tuple[str, str], ...] = ()

    def key_header(self, api_key: str) -> dict[str, str]:
        """:returns: The one header that carries *api_key* to this upstream."""
        if self.auth == "x-api-key":
            return {"x-api-key": api_key}
        return {"Authorization": f"Bearer {api_key}"}

    def auth_headers(self, api_key: str) -> dict[str, str]:
        """:returns: Every header a standalone request (the probe) needs."""
        return {**dict(self.extra_headers), **self.key_header(api_key)}

    @property
    def probe_url(self) -> str:
        """:returns: The full URL of the key probe."""
        return f"{self.base_url}{self.probe_path}"


UPSTREAMS: dict[str, Upstream] = {
    "anthropic": Upstream(
        name="anthropic",
        label="Anthropic",
        base_url="https://api.anthropic.com",
        auth="x-api-key",
        wire_apis=frozenset({"messages"}),
        vendors_served="claude",
        probe_path="/v1/models",
        extra_headers=(("anthropic-version", "2023-06-01"),),
    ),
    "openrouter": Upstream(
        name="openrouter",
        label="OpenRouter",
        # Its Anthropic-compatible Messages API lives at /api/v1/messages.
        base_url="https://openrouter.ai/api",
        auth="bearer",
        wire_apis=frozenset({"messages", "chat"}),
        vendors_served="any",
        probe_path="/v1/key",
    ),
    # OpenAI is deliberately not wired yet (needs the "responses" wire API):
    # "openai": Upstream("openai", "OpenAI", "https://api.openai.com", "bearer",
    #                    frozenset({"responses", "chat"}), "any", "/v1/models"),
}
PROVIDERS = tuple(UPSTREAMS)


# Both families prefer Anthropic then OpenRouter for now; a later slice differentiates them.
_PREFERENCE = {
    "claude": ("anthropic", "openrouter"),
    "multi": ("anthropic", "openrouter"),
}


def preferred_providers(harness_family: str) -> tuple[str, ...]:
    """:returns: Providers to try, best first, for a harness family (``claude`` or ``multi``)."""
    return _PREFERENCE[harness_family]
