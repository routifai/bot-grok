"""The provider registry: one table describing every model upstream the engine can call.

The probe (key validation), the model proxy (where a call goes and how it is authenticated) and
the connection routes (which providers exist) all read this table; nothing else hardcodes a
provider. ``vendors_served`` and ``wire_apis`` are the facts later slices filter on (which model
vendors a harness can reach through an upstream, and over which wire protocol).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from omnigent.harness_aliases import canonicalize_harness
from omnigent.models.model_override import canonical_model_spelling

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
    :param id_mapper: Rewrites a catalog model id into the spelling this upstream expects (the
        proxy applies it before forwarding); ``None`` when ids pass through unchanged.
    """

    name: str
    label: str
    base_url: str
    auth: AuthStyle
    wire_apis: frozenset[str]
    vendors_served: Literal["claude", "any"]
    probe_path: str
    extra_headers: tuple[tuple[str, str], ...] = ()
    id_mapper: Callable[[str], str] | None = None

    def serves_model(self, model: str) -> bool:
        """:returns: Whether this upstream can serve *model* (a claude-only one serves Claude)."""
        return self.vendors_served == "any" or "claude" in model.lower()

    def upstream_model(self, model: str) -> str:
        """:returns: *model* spelled the way this upstream expects it."""
        return self.id_mapper(model) if self.id_mapper else model

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


# Bare dated suffix ("-20250514") and a trailing "<major>-<minor>" or leading "<major>-<minor>-".
_DATE_SUFFIX = re.compile(r"-\d{8}$")
_CLAUDE_VERSION_AFTER = re.compile(r"^(claude-[a-z]+)-(\d{1,2})-(\d{1,2})$")
_CLAUDE_VERSION_BEFORE = re.compile(r"^claude-(\d{1,2})-(\d{1,2})-([a-z]+)$")


def openrouter_model_id(model: str) -> str:
    """Spell a catalog model id the way OpenRouter does.

    OpenRouter ids are vendor-prefixed with dotted versions (``anthropic/claude-sonnet-4.5``)
    while the catalog's Claude ids are bare and dashed (``claude-sonnet-4-5``). A bare Claude id
    (a ``databricks-`` gateway prefix and a date suffix are dropped first) becomes
    ``anthropic/claude-<name>-<major>.<minor>`` (or ``claude-<major>.<minor>-<name>`` for the 3.x
    shape); any other id, including one already carrying a ``/``, passes through unchanged.
    """
    bare = canonical_model_spelling(model)
    if "/" in bare or not bare.startswith("claude-"):
        return model
    bare = _DATE_SUFFIX.sub("", bare)
    if m := _CLAUDE_VERSION_AFTER.match(bare):
        bare = f"{m[1]}-{m[2]}.{m[3]}"
    elif m := _CLAUDE_VERSION_BEFORE.match(bare):
        bare = f"claude-{m[1]}.{m[2]}-{m[3]}"
    return f"anthropic/{bare}"


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
        id_mapper=openrouter_model_id,
    ),
    # OpenAI is deliberately not wired yet (needs the "responses" wire API):
    # "openai": Upstream("openai", "OpenAI", "https://api.openai.com", "bearer",
    #                    frozenset({"responses", "chat"}), "any", "/v1/models"),
}
PROVIDERS = tuple(UPSTREAMS)


def harness_family(harness: str) -> str:
    """:returns: The vendor family a harness declares in its capabilities (``claude``, ``gpt``,
    ``gemini`` or ``multi``); ``multi`` when the harness declares nothing."""
    from omnigent.harness_plugins import harness_capabilities

    capabilities = harness_capabilities()
    caps = capabilities.get(harness) or capabilities.get(canonicalize_harness(harness) or harness)
    return caps.model_family.value if caps is not None else "multi"


# Providers per family, best first; a later slice may order claude and multi differently.
_PREFERENCE = ("anthropic", "openrouter")


def preferred_providers(family: str) -> tuple[str, ...]:
    """:returns: Providers to try, best first, among those that can serve *family*.

    An upstream with ``vendors_served == "claude"`` only serves the ``claude`` and ``multi``
    families (``multi`` harnesses reach Claude ids through it).
    """
    return tuple(
        name
        for name in _PREFERENCE
        if UPSTREAMS[name].vendors_served == "any" or family in ("claude", "multi")
    )
