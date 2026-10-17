"""Translate the omnigent-configured model provider into native Pi config.

A native Pi session launches the ``pi`` CLI, which authenticates from its own
config directory (``~/.pi/agent``). Without help, a user who ran ``omnigent
setup`` would still have to run ``pi`` ``/login`` separately — unlike
claude-native / codex-native, which route through the provider that ``omnigent
setup`` configured.

This module closes that gap. It resolves the provider configured for the Pi
surface (``~/.omnigent/config.yaml``) and writes a per-session ``models.json``
into a *managed* Pi config dir (selected via ``PI_CODING_AGENT_DIR``), so the
runner-owned ``pi`` process authenticates exactly like the configured harness.

The managed config dir is per-session (like codex-native's managed
``CODEX_HOME``), so this never mutates the user's global ``~/.pi/agent``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple, NotRequired, TypeAlias, TypedDict, TypeGuard

from omnigent.models import model_catalog
from omnigent.models.model_override import normalize_model_for_provider
from omnigent.models.pi_model_compatibility import (
    PI_CLAUDE_THINKING_MODEL_FRAGMENTS,
    PiModelEntry,
    pi_model_is_reasoning,
)
from omnigent.onboarding.provider_config import (
    ANTHROPIC_FAMILY,
    CHAT_WIRE_API,
    GATEWAY_KIND,
    KEY_KIND,
    LOCAL_KIND,
    PI_SURFACE,
    FamilyConfig,
    ProviderEntry,
    default_provider_for_harness,
    load_config,
)
from omnigent.util.reasoning_effort import (
    EFFORT_CLEAR_VALUES,
    PI_EFFORTS,
    PI_THINKING_OFF,
    to_pi_thinking_level,
    validate_effort,
)

if TYPE_CHECKING:
    import httpx

    from omnigent.spec.types import ExecutorAuth

_LOGGER = logging.getLogger(__name__)

# Env var the ``pi`` CLI reads to relocate its config dir (default
# ``~/.pi/agent``). Setting it per session gives Pi a managed, isolated
# config dir we own — the analog of codex-native's ``CODEX_HOME``.
PI_CODING_AGENT_DIR_ENV_VAR = "PI_CODING_AGENT_DIR"

# Provider id registered in the generated ``models.json``. Stable so
# ``--provider`` can select it.
_PI_PROVIDER_ID = "omnigent"

# Provider id for the secondary OpenAI Responses provider (GPT models that only
# support tools via the Responses API, e.g. gpt-5.5, gpt-5.6-*).
_PI_OPENAI_PROVIDER_ID = "omnigent-openai"

# Provider id for the tertiary OpenAI Completions provider (models served
# over /chat/completions).
_PI_COMPLETIONS_PROVIDER_ID = "omnigent-completions"

_PI_MANAGED_PROVIDER_IDS = frozenset(
    {_PI_PROVIDER_ID, _PI_OPENAI_PROVIDER_ID, _PI_COMPLETIONS_PROVIDER_ID}
)


# Declared in pi_model_compatibility so the harness and interactive paths
# render byte-identical entries.
_PiModelEntry: TypeAlias = PiModelEntry


def _split_pi_native_model_selection(selection: str | None) -> tuple[str, str] | None:
    """Split an Omnigent-managed ``provider/model`` picker value."""
    if not selection:
        return None
    provider_id, separator, model_id = selection.partition("/")
    if separator and provider_id in _PI_MANAGED_PROVIDER_IDS and model_id:
        return provider_id, model_id
    return None


class _PiProviderCompat(TypedDict, total=False):
    supportsDeveloperRole: bool
    supportsStore: bool
    supportsStrictMode: bool
    supportsReasoningEffort: bool
    supportsUsageInStreaming: bool
    # Pi 0.84.2+: send thinking.type.adaptive + output_config.effort instead
    # of thinking.type.enabled + budget_tokens. Required for claude-4+ / claude-5
    # models which no longer accept thinking.type.enabled.
    forceAdaptiveThinking: bool


class _PiProviderPayload(TypedDict):
    baseUrl: str
    apiKey: str
    api: str
    models: list[_PiModelEntry]
    authHeader: NotRequired[bool]
    compat: NotRequired[_PiProviderCompat]


class _PiModelsConfig(TypedDict):
    providers: dict[str, _PiProviderPayload]


def _is_str_object_dict(value: object) -> TypeGuard[dict[str, object]]:
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


@dataclass(frozen=True)
class PiProviderConfig:
    """A resolved native-Pi provider, ready to render into ``models.json``.

    :param provider_id: Provider id used in ``models.json`` and ``--provider``.
    :param base_url: Endpoint base URL the ``pi`` CLI talks to.
    :param api: Pi API type, e.g. ``"anthropic-messages"`` or
        ``"openai-responses"``.
    :param model: Model id to select, e.g. ``"claude-sonnet-4-6"``.
    :param api_key: Credential value for ``models.json`` ``apiKey`` — a literal
        key, an env-var name, or a ``"!command"`` shell form (resolved by Pi at
        request time, used for short-lived gateway tokens).
    :param auth_header: When ``True``, Pi sends ``Authorization: Bearer
        <apiKey>`` (gateways) instead of a provider-native key header.
    :param credential_warning: A user-facing notice the caller surfaces when
        the session may not reach its model (e.g. a model routed over the other
        family's wire).
    :param listing_provider: Model-catalog descriptor of the key/gateway/local
        endpoint whose live model inventory the pre-launch picker enumerates.
        Metadata for the picker only — never rendered into ``models.json``.
    """

    provider_id: str
    base_url: str
    api: str
    model: str
    api_key: str
    auth_header: bool
    credential_warning: str | None = None
    # Full model list for providers that expose multiple models. Excluded from
    # __hash__ so the frozen dataclass stays hashable even though list[dict]
    # is not hashable.
    extra_models: list[_PiModelEntry] = field(default_factory=list, hash=False)
    # Extra providers to merge into models.json alongside the primary one (e.g.
    # an OpenAI Responses provider for an inference binding's GPT models).
    # Keys are provider ids; values are complete Pi provider config dicts.
    additional_providers: dict[str, _PiProviderPayload] = field(default_factory=dict, hash=False)
    # Excluded from __hash__/__eq__ too: two configs that render the same
    # models.json are equal regardless of how the picker discovered the ids.
    listing_provider: model_catalog.ResolvedModelProvider | None = field(
        default=None, hash=False, compare=False
    )
    # Only configured tier maps with multiple distinct models scope the picker.
    curated_models: bool = False
    model_allowlist: tuple[str, ...] | None = None
    inference_bound: bool = False

    def _model_registered_in_additional(self) -> bool:
        """Whether some secondary provider already serves the selected model."""
        return any(
            any(entry.get("id") == self.model for entry in provider["models"])
            for provider in self.additional_providers.values()
        )

    def to_models_config(self) -> _PiModelsConfig:
        """Render this provider as a Pi ``models.json`` mapping."""
        models: list[_PiModelEntry] = list(self.extra_models)
        additional: dict[str, _PiProviderPayload] = dict(self.additional_providers)
        # Register the selected model only when no provider already serves it.
        needs_registration = not self._model_registered_in_additional() and not any(
            entry.get("id") == self.model for entry in models
        )
        if needs_registration:
            # The primary's api came from the model's own family.
            base: _PiModelEntry = (
                {"id": self.model, "input": ["text", "image"]}
                if self.extra_models
                else {"id": self.model}
            )
            if self.api == "anthropic-messages":
                base["reasoning"] = True
            models.append(base)
        provider: _PiProviderPayload = {
            "baseUrl": self.base_url,
            "api": self.api,
            "apiKey": self.api_key,
            "models": models,
        }
        if self.auth_header:
            provider["authHeader"] = True
        # Claude 4+ / Claude 5 models require thinking.type.adaptive (not
        # thinking.type.enabled). Pi 0.84.2+ sends adaptive when forceAdaptiveThinking
        # is set in the compat block; reasoning:true on the model entry enables Pi's
        # thinking level controls.
        if self.api == "anthropic-messages":
            provider["compat"] = {"forceAdaptiveThinking": True}
        providers = {self.provider_id: provider}
        providers.update(additional)
        return {"providers": providers}


def _global_pi_agent_dir() -> Path:
    """Return Pi's own agent config root (``~/.pi/agent`` by default).

    Honours Pi's ``PI_CODING_AGENT_DIR`` override so the pre-launch catalog
    reads the same login the launched Pi would.
    """
    override = os.environ.get(PI_CODING_AGENT_DIR_ENV_VAR, "").strip()
    if override:
        return Path(override)
    return Path.home() / ".pi" / "agent"


def _read_json_object(path: Path) -> dict[str, object]:
    """Load a JSON object from *path*, returning ``{}`` when absent/invalid."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if _is_str_object_dict(raw) else {}


def pi_own_login_model_options(agent_dir: Path | None = None) -> list[dict[str, object]]:
    """Enumerate the models Pi's own login can use (the unmanaged fallback).

    When no omnigent-managed provider is configured, the launched Pi runs on
    its own credentials, so the pre-launch picker must offer the models that
    login can actually drive: Pi's ``models-store.json`` catalog filtered to
    providers with an ``auth.json`` entry.

    :param agent_dir: Pi agent dir override (tests); defaults to the host's
        own Pi agent dir.
    :returns: Picker options shaped like :func:`pi_native_model_options`,
        qualified as ``provider/model`` — the reference form Pi's ``--model``
        resolves natively against its own providers.
    """
    root = agent_dir if agent_dir is not None else _global_pi_agent_dir()
    logged_in = set(_read_json_object(root / "auth.json"))
    if not logged_in:
        return []
    options: dict[str, dict[str, object]] = {}
    for provider_id, payload in _read_json_object(root / "models-store.json").items():
        if provider_id not in logged_in or not _is_str_object_dict(payload):
            continue
        models = payload.get("models")
        for model in models if isinstance(models, list) else []:
            if not _is_str_object_dict(model):
                continue
            model_id = model.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            qualified = f"{provider_id}/{model_id}"
            name = model.get("name")
            options[qualified] = {
                "id": qualified,
                "model": qualified,
                "displayName": name if isinstance(name, str) and name else model_id,
            }
    return [options[model_id] for model_id in sorted(options)]


def pi_own_login_model_arg(selection: str) -> str | None:
    """Return the ``--model`` value for a Pi running on its own login.

    A managed ``provider/model`` picker value names a provider that does not
    exist without omnigent-managed config, so only the model id survives; any
    other reference (``anthropic/claude-...`` or a bare id) passes through
    unchanged for Pi's own resolver.

    A managed selection whose model id itself contains a ``/`` (e.g.
    ``omnigent/moonshotai/kimi-k2.5``) is refused with ``None``: stripping the
    managed prefix would leave a bare slash-bearing id whose leading segment
    Pi's ``--model`` parser reads as a *provider*, silently mis-routing the
    launch to an unrelated built-in provider. Such a pick is unresolvable
    without the managed provider, so the launch falls back to Pi's own
    default model instead.
    """
    split = _split_pi_native_model_selection(selection)
    if split is None:
        return selection
    return None if "/" in split[1] else split[1]


def _default_model_provider_id(provider: PiProviderConfig, rendered: _PiModelsConfig) -> str:
    """Return the rendered provider Pi opens ``provider.model`` on without a selection.

    Non-Claude models (GLM, GPT, Llama…) register on a secondary provider and
    everything else on the primary. The launch and the pre-launch picker both
    resolve the default here, so the picker's ``isDefault`` row is the model
    Pi actually opens.
    """
    for provider_id, payload in rendered["providers"].items():
        if provider_id == provider.provider_id:
            continue
        if any(model.get("id") == provider.model for model in payload["models"]):
            return provider_id
    return provider.provider_id


def pi_native_model_options(
    *,
    config_loader: Callable[[], dict[str, object]] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> list[dict[str, object]]:
    """Return the pre-launch Pi model choices for this host.

    Prefers the provider configured through ``omni setup``; key/gateway/local
    providers render their endpoint's live model listing, so the picker offers
    the models the endpoint actually serves rather than only the configured
    default. When none is configured the launched Pi runs on its own login, so
    that login's models (:func:`pi_own_login_model_options`) are the honest
    catalog.

    :param config_loader: Injection seam for tests; ``None`` uses
        :func:`load_config` through
        :func:`resolve_pi_native_provider`.
    :param transport: Optional httpx transport override for tests, forwarded to
        the live listing fetch.
    :returns: One pre-launch option per model, sorted by qualified id. The row
        Pi opens when no model is selected carries ``isDefault``.
    """
    # Forward only the config_loader seam: tests replace the module-level
    # resolver with a zero-argument callable, so a bare picker call must stay
    # bare. The transport is NOT threaded through resolution — the listing is
    # fetched below, off the launch path.
    if config_loader is None:
        provider = resolve_pi_native_provider()
    else:
        provider = resolve_pi_native_provider(config_loader=config_loader)
    if provider is None:
        return pi_own_login_model_options()
    provider = replace(
        provider, extra_models=_live_family_model_entries(provider, transport=transport)
    )

    rendered = provider.to_models_config()
    default_option = f"{_default_model_provider_id(provider, rendered)}/{provider.model}"
    options: dict[str, dict[str, object]] = {}
    for provider_id, payload in rendered["providers"].items():
        for model in payload["models"]:
            model_id = model["id"]
            qualified = f"{provider_id}/{model_id}"
            options[qualified] = {
                "id": qualified,
                "model": qualified,
                "displayName": model.get("name") or model_id,
                "isDefault": qualified == default_option,
            }
    return [options[model_id] for model_id in sorted(options)]


def _family_tier_ids(family: FamilyConfig) -> list[str]:
    """Return a family's configured tier models as deduplicated endpoint ids.

    Aliases are resolved and bracket suffixes stripped so two tiers naming the
    same endpoint count once.

    :param family: A resolved provider family.
    :returns: Ordered unique model ids, e.g. ``["gpt-5", "gpt-5-mini"]``.
    """
    return list(
        dict.fromkeys(
            re.sub(r"\[.*?\]$", "", family.resolve_model_tier(tier_model))
            for tier_model in family.models.values()
            if isinstance(tier_model, str) and tier_model
        )
    )


def _inline_family_order(model: str | None) -> tuple[str, ...]:
    """Order the inline families to try, model's own family first.

    Only Claude ids prefer the Anthropic family. Everything else — GPT, and the
    Gemini/Llama/DeepSeek ids that token as ``"other"`` — is served over an
    OpenAI-compatible wire by nearly every gateway, so it leads with OpenAI.
    With no model to go on, Anthropic leads: Pi speaks it natively.
    """
    # An Anthropic-wire-only non-Claude id would prefer the wrong surface here;
    # only a dual-surface provider is exposed, since the loop falls through.
    if model and model_catalog.model_family_token(model) != "claude":
        return ("openai", "anthropic")
    return ("anthropic", "openai")


# Family that natively serves each known model-family token. "other" ids are
# absent on purpose: they carry no routing expectation, so their fallthrough
# stays silent (the LiteLLM-passthrough intent).
_FAMILY_FOR_MODEL_TOKEN = {"claude": "anthropic", "openai": "openai"}


def _cross_family_routing_warning(
    entry: ProviderEntry, family_name: str, model_id: str
) -> str | None:
    """Warn when a known-family model is served over the other family's wire.

    The fallthrough in :func:`_inline_family_pi_provider` keeps
    protocol-translating proxies working, but on a raw passthrough endpoint it
    misroutes — e.g. a Claude id POSTed to the OpenAI ``/chat/completions``
    surface 404s on every turn. The caller surfaces this as an advisory
    banner; the session still launches, so translating proxies keep working.

    :param entry: The resolved provider entry.
    :param family_name: The family that actually serves the session.
    :param model_id: The model id being registered.
    :returns: The warning text, or ``None`` when routing is unsurprising.
    """
    expected = _FAMILY_FOR_MODEL_TOKEN.get(model_catalog.model_family_token(model_id))
    if expected is None or expected == family_name:
        return None
    return (
        f"The model '{model_id}' is normally served by a provider's '{expected}' "
        f"family, but provider '{entry.name}' could not serve it that way (its "
        f"'{expected}' family is missing, or lacks a base URL, credential, or "
        f"model), so the session was routed to its '{family_name}' endpoint. "
        "If that endpoint does not serve this model, every turn will fail (for "
        f"example with a 404). Add a usable '{expected}' family to the provider "
        f"config, or pick a model its '{family_name}' family serves."
    )


def _gateway_pi_model_entry(
    model_id: str,
    *,
    configured_context_window: int | None = None,
    configured_max_output_tokens: int | None = None,
) -> _PiModelEntry:
    """Build a Pi models.json entry for a generic gateway model.

    Pi defaults a model entry with no ``contextWindow``/``maxTokens`` to
    128k/16k, silently truncating large-context gateway models (e.g. a 1M-
    context GLM).  This helper enriches the entry with real limits.

    Resolution order (first value found wins per field):
    1. Provider-config-supplied ``context_window``/``max_output_tokens``.
    2. Best-effort catalog fuzzy match by normalised model id fragment
       (``glm-5.2`` → ``glm-5-2``).
    3. No ``contextWindow``/``maxTokens`` key — Pi uses its own defaults;
       still better than a completely bare entry because ``reasoning`` and
       ``input`` are set correctly.

    ``reasoning`` is set via :func:`pi_model_is_reasoning` so that DeepSeek
    and similar chain-of-thought models surface their thinking channel in Pi.

    :param model_id: The gateway model id as configured by the user,
        e.g. ``"glm-5.2"`` or ``"deepseek-r2"``.
    :param configured_context_window: User-supplied context limit from the
        provider config's ``context_window`` field, or ``None``.
    :param configured_max_output_tokens: User-supplied output limit from the
        provider config's ``max_output_tokens`` field, or ``None``.
    :returns: A Pi model entry with as many fields populated as possible.
    """
    entry: _PiModelEntry = {"id": model_id, "input": ["text", "image"]}
    # Set reasoning for DeepSeek (reads reasoning_content channel) and for
    # Claude (enables Pi's thinking level controls).
    if pi_model_is_reasoning(model_id) or any(
        fragment in model_id.lower() for fragment in PI_CLAUDE_THINKING_MODEL_FRAGMENTS
    ):
        entry["reasoning"] = True

    # Determine context window and max output tokens.
    context_window = configured_context_window
    max_output_tokens = configured_max_output_tokens

    # Fall back to a catalog fuzzy match when the user hasn't configured limits.
    if context_window is None or max_output_tokens is None:
        catalog_entry = _catalog_entry_for_model(model_id)
        if catalog_entry is not None:
            if context_window is None and catalog_entry.metadata.context_window is not None:
                context_window = catalog_entry.metadata.context_window
            if max_output_tokens is None and catalog_entry.metadata.max_output_tokens is not None:
                max_output_tokens = catalog_entry.metadata.max_output_tokens

    if context_window is not None:
        entry["contextWindow"] = context_window
    if max_output_tokens is not None:
        entry["maxTokens"] = max_output_tokens
    return entry


def _catalog_entry_for_model(model_id: str) -> model_catalog.ModelEntry | None:
    """Find the best catalog entry for *model_id* by normalised id fragment.

    Tries an exact match first, then a prefix-aware substring match so that
    user-facing ids like ``glm-5.2`` resolve against catalog entries like
    ``vendor-glm-5-2``.  Normalises dots to dashes for version numbers.

    :param model_id: A model id, e.g. ``"glm-5.2"`` or ``"gpt-4o-mini"``.
    :returns: The best matching catalog :class:`ModelEntry`, or ``None``.
    """
    lower = model_id.lower()
    # Normalise dots to dashes so "glm-5.2" matches "vendor-glm-5-2".
    normalised = lower.replace(".", "-")

    all_entries: list[model_catalog.ModelEntry] = []
    for provider in ("openai", "anthropic", "google"):
        with contextlib.suppress(Exception):  # catalog failure must not break launch
            all_entries.extend(model_catalog.catalog_model_entries(provider))

    # 1. Exact match (covers common ids like "gpt-4o-mini").
    for entry in all_entries:
        if entry.id.lower() == lower:
            return entry

    # 2. Normalised substring match (covers "glm-5.2" → "vendor-glm-5-2").
    for entry in all_entries:
        if normalised in entry.id.lower().replace(".", "-"):
            return entry

    return None


def _live_family_model_entries(
    provider: PiProviderConfig,
    *,
    transport: httpx.BaseTransport | None,
) -> list[_PiModelEntry]:
    """Enumerate a key/gateway endpoint's models for the pre-launch picker.

    The rendered ``models.json`` otherwise carries only the configured default,
    so the picker offered one row while the endpoint served several. Ask the
    endpoint's own listing through the shared model-catalog fetchers, and keep
    the configured default first:
    it still launches when the listing is unreachable.

    :param provider: The resolved provider; its ``listing_provider`` names the
        endpoint to list and ``extra_models`` holds the configured default.
    :param transport: Optional httpx transport override for tests.
    :returns: The configured entries followed by every live model id, deduped;
        unchanged when the listing fails.
    """
    if provider.model_allowlist is not None:
        return list(provider.extra_models)
    listing_provider = provider.listing_provider
    if listing_provider is None:
        return list(provider.extra_models)
    try:
        # Mirror the catalog's routing: only a real Anthropic key speaks the
        # Anthropic models API; a gateway's family endpoint proxies messages,
        # so its inventory comes from the OpenAI-compatible listing.
        if listing_provider.kind == KEY_KIND and listing_provider.family == ANTHROPIC_FAMILY:
            listing = model_catalog._fetch_anthropic_listing(listing_provider, transport=transport)
        else:
            listing = model_catalog._fetch_openai_compatible_listing(
                listing_provider, transport=transport
            )
    except Exception:  # noqa: BLE001 — an unreachable listing must not break the picker
        _LOGGER.info(
            "pi-native: could not list models for provider %s; offering only the "
            "configured default",
            listing_provider.detail or listing_provider.kind,
            exc_info=True,
        )
        return list(provider.extra_models)

    entries = list(provider.extra_models)
    seen = {entry.get("id") for entry in entries}
    for model_entry in listing.models:
        if model_entry.id in seen:
            continue
        seen.add(model_entry.id)
        entries.append(_gateway_pi_model_entry(model_entry.id))
    return entries


def _inline_family_pi_provider(
    entry: ProviderEntry, *, model: str | None, preserve_model_ids: bool = False
) -> PiProviderConfig | None:
    """Resolve a key/gateway/local provider into Pi config from its family.

    Tries the family matching the selected model first, so a provider offering
    both surfaces serves a GPT id from its OpenAI family rather than whichever
    family happens to be configured first. Falls back to the other family, which
    keeps protocol-translating proxies working: a LiteLLM ``/anthropic``
    passthrough is the only configured family and still serves any model.

    :param entry: The resolved default provider entry.
    :param model: Session model override, or ``None`` to use the family default.
    :returns: The Pi provider config, or ``None`` when no usable family with a
        base URL and credential is configured.
    """
    for family_name in _inline_family_order(model):
        family = entry.family(family_name)
        if family is None or not family.base_url:
            continue
        # Determine the API type based on family and wire_api setting.
        if family_name == "anthropic":
            api = "anthropic-messages"
        elif family.wire_api == CHAT_WIRE_API:
            api = "openai-completions"
        else:
            api = "openai-responses"
        # A static key (or $VAR) — Pi reads a literal/env apiKey directly; an
        # auth_command becomes a "!command" Pi resolves at request time.
        if family.api_key:
            api_key = family.api_key
            auth_header = False
        elif family.auth_command:
            api_key = f"!{family.auth_command}"
            auth_header = True
        else:
            continue
        if model is not None:
            resolved_model = model
        else:
            # A ``default:`` tier may name another tier (an alias such as
            # ``deepseek-pro: deepseek-v4-pro``); launch with the id the
            # endpoint actually serves, not the alias.
            default_tier = entry.family_default_model(family_name)
            resolved_model = family.resolve_model_tier(default_tier) if default_tier else None
        if not resolved_model:
            continue
        # A session override can arrive as a gateway-prefixed id; strip the
        # mechanical prefix for a vendor-direct (key-kind) endpoint.
        # Gateway/local kinds pass through verbatim — they front arbitrary
        # inventories. A configured family default is exempt — it names an id
        # its own endpoint serves.
        if model is not None and not preserve_model_ids:
            resolved_model = normalize_model_for_provider(resolved_model, entry.kind)
        # Strip bracket suffixes (e.g. "[1m]") — accepted by the direct
        # Anthropic API but rejected by many gateways, and in a Pi
        # ``enabledModels`` ref the "[" would route the pattern through Pi's
        # glob matcher instead of its exact reference match.
        if not preserve_model_ids:
            resolved_model = re.sub(r"\[.*?\]$", "", resolved_model)
        tier_ids = _family_tier_ids(family)
        # A session override must not turn a default-only setup into a shortlist.
        curated_models = len(tier_ids) > 1
        model_entry = _gateway_pi_model_entry(
            resolved_model,
            configured_context_window=family.context_window,
            configured_max_output_tokens=family.max_output_tokens,
        )
        # Register the family's tiers alongside the selected model.
        shortlist: list[_PiModelEntry] = [model_entry]
        if curated_models:
            for tier_id in tier_ids:
                if tier_id == resolved_model:
                    continue
                shortlist.append(
                    _gateway_pi_model_entry(
                        tier_id,
                        configured_context_window=family.context_window,
                        configured_max_output_tokens=family.max_output_tokens,
                    )
                )
        return PiProviderConfig(
            provider_id=_PI_PROVIDER_ID,
            base_url=family.base_url,
            api=api,
            model=resolved_model,
            api_key=api_key,
            auth_header=auth_header,
            # Advisory when the model landed on the other family's wire; a raw
            # passthrough endpoint rejects it, and silence reads as a hang.
            credential_warning=_cross_family_routing_warning(entry, family_name, resolved_model),
            extra_models=shortlist,
            curated_models=curated_models,
            # Record the endpoint the pre-launch picker can enumerate live; no
            # I/O happens here so session launch stays off the network.
            listing_provider=model_catalog.ResolvedModelProvider(
                kind=entry.kind,
                family=family_name,
                base_url=family.base_url,
                api_key=family.api_key,
                auth_command=family.auth_command,
                detail=f"provider {entry.name!r}",
            ),
        )
    return None


def resolve_pi_native_provider(
    *,
    model: str | None = None,
    config_loader: Callable[[], dict[str, object]] = load_config,
    auth: ExecutorAuth | None = None,
) -> PiProviderConfig | None:
    """Resolve the omnigent-configured provider for a native Pi session.

    Reads the default provider for the Pi surface from
    ``~/.omnigent/config.yaml`` and translates it into Pi ``models.json``
    config. Returns ``None`` — leaving Pi to use its own ``/login`` — when no
    usable provider is configured, or the default is a subscription / CLI-login
    provider (a CLI's own login can't be reused outside that CLI).

    :param model: Session model override (``model_override``), or ``None`` to
        use the provider's default model.
    :param config_loader: Injection seam for tests; defaults to
        :func:`load_config`.
    :returns: The resolved provider config, or ``None`` to fall back to Pi's
        own credentials.
    """
    from omnigent.inference_config import (
        binding_for_harness,
        load_runtime_inference_config,
        resolve_bound_model,
        resolve_bound_provider,
    )

    try:
        if config_loader is load_config:
            from omnigent.onboarding.provider_config import _load_config

            base_config = _load_config()
        else:
            base_config = config_loader()
    except Exception:  # noqa: BLE001 — legacy config failures fall back to Pi's own login
        _LOGGER.warning("pi-native: failed to read provider configuration", exc_info=True)
        return None
    config = load_runtime_inference_config(base_config)
    binding = binding_for_harness(config, "pi-native")
    if binding is not None:
        entry = resolve_bound_provider(config, "pi-native", auth)
        selected = resolve_bound_model(config, "pi-native", model)
        if entry is None:
            raise ValueError("The Pi inference binding has no configured provider.")
        resolved = _inline_family_pi_provider(entry, model=selected, preserve_model_ids=True)
        if resolved is None:
            raise ValueError(f"Configured provider {entry.name!r} cannot route Pi.")
        if binding.model_allowlist is not None:
            grouped: dict[str, PiProviderConfig] = {}
            provider_ids = {
                "anthropic-messages": _PI_PROVIDER_ID,
                "openai-responses": _PI_OPENAI_PROVIDER_ID,
                "openai-completions": _PI_COMPLETIONS_PROVIDER_ID,
            }
            for model_id in binding.model_allowlist:
                routed = _inline_family_pi_provider(entry, model=model_id, preserve_model_ids=True)
                if routed is None:
                    raise ValueError(
                        f"Configured provider {entry.name!r} cannot route {model_id!r}."
                    )
                provider_id = provider_ids[routed.api]
                model_entry = next(row for row in routed.extra_models if row["id"] == model_id)
                previous = grouped.get(provider_id)
                grouped[provider_id] = replace(
                    routed,
                    provider_id=provider_id,
                    extra_models=[*(previous.extra_models if previous else []), model_entry],
                )
            primary_id = provider_ids[resolved.api]
            primary = grouped.pop(primary_id)
            resolved = replace(
                primary,
                model=resolved.model,
                additional_providers={
                    pid: provider.to_models_config()["providers"][pid]
                    for pid, provider in grouped.items()
                },
                curated_models=True,
                model_allowlist=binding.model_allowlist,
            )
        return replace(resolved, inference_bound=True)

    selection = _split_pi_native_model_selection(model)
    unmanaged_prefix_warning: str | None = None
    if selection is not None:
        _, model = selection
    try:
        # Pi is multi-family; ``omnigent setup`` marks defaults per family, not
        # for ``pi``. Use the shared house-pattern selection so pi resolves its
        # default exactly like the rest of the codebase — an explicit pi default
        # wins, else the anthropic (Pi's native surface) then openai family
        # default, skipping kinds that can't drive pi.
        entry = default_provider_for_harness(config, PI_SURFACE)
        if entry is None:
            _LOGGER.info(
                "pi-native: no omnigent-configured provider for the pi/anthropic/openai "
                "surface; Pi will use its own login."
            )
            return None
        if selection is None and model and "/" in model:
            prefix, _, bare = model.partition("/")
            providers = config.get("providers")
            # A picker override can arrive qualified by the omnigent provider
            # name ("team-gateway/claude-fable-5-1"); registering it
            # verbatim renders a slash id no endpoint serves. Split only when
            # the prefix names a configured provider — any other slash id is
            # the endpoint's own model naming (e.g. "openai/gpt-4o" on
            # OpenRouter, "zai-org/GLM-4.7") and must stay verbatim.
            if bare and isinstance(providers, dict) and prefix in providers:
                if prefix != entry.name:
                    unmanaged_prefix_warning = (
                        f"The model override '{model}' names provider "
                        f"'{prefix}', but this Pi session is served by "
                        f"provider '{entry.name}'; the model '{bare}' was "
                        f"requested from '{entry.name}' instead."
                    )
                    _LOGGER.warning("pi-native: %s", unmanaged_prefix_warning)
                model = bare
        if entry.kind in (KEY_KIND, GATEWAY_KIND, LOCAL_KIND):
            resolved = _inline_family_pi_provider(entry, model=model)
        else:
            # subscription / cli-config (a CLI's own login or config can't be
            # reused outside that CLI): let Pi use its own login.
            _LOGGER.info(
                "pi-native: configured provider %r (kind %r) cannot drive Pi; "
                "Pi will use its own login.",
                entry.name,
                entry.kind,
            )
            return None
        if resolved is None:
            _LOGGER.warning("pi-native: no usable provider found; Pi will use its own login.")
        if resolved is not None and unmanaged_prefix_warning is not None:
            resolved = replace(
                resolved,
                credential_warning=(
                    unmanaged_prefix_warning
                    if resolved.credential_warning is None
                    else f"{unmanaged_prefix_warning}\n\n{resolved.credential_warning}"
                ),
            )
        return resolved
    except Exception:  # noqa: BLE001 — any resolution failure must not break launch
        # Any failure (malformed config, duplicate per-family default, or an
        # unresolved ``api_key: $VAR``) falls back to Pi's own login rather than
        # failing the terminal launch.
        _LOGGER.warning(
            "pi-native: failed to resolve the omnigent-configured provider; Pi will "
            "use its own login.",
            exc_info=True,
        )
        return None


def write_pi_models_config(
    agent_dir: Path,
    provider: PiProviderConfig,
    rendered: _PiModelsConfig | None = None,
) -> Path:
    """Write *provider* as ``models.json`` into a managed Pi config dir.

    :param agent_dir: The managed Pi config dir (``PI_CODING_AGENT_DIR``).
    :param provider: The resolved provider config to render.
    :param rendered: An already-rendered config to write, so a caller that also
        inspects it renders (and logs) only once. Defaults to rendering here.
    :returns: Path to the written ``models.json``.
    """
    if rendered is None:
        rendered = provider.to_models_config()
    agent_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(agent_dir, 0o700)
    models_path = agent_dir / "models.json"
    # 0o600: the apiKey may be a literal token (key-kind providers).
    fd = os.open(models_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(rendered, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return models_path


def _enabled_model_refs(rendered: _PiModelsConfig) -> list[str]:
    """Build provider-qualified ``enabledModels`` refs for a rendered config.

    This is a picker preference; users can toggle back to all models.

    :param rendered: The rendered ``models.json`` mapping.
    :returns: ``["provider/model", ...]`` refs in rendered order (deterministic,
        matching the picker's listing order).
    """
    refs: list[str] = []
    providers = rendered.get("providers", {})
    for provider_id, payload in providers.items():
        if not isinstance(payload, dict):
            continue
        for model in payload.get("models", []):
            if isinstance(model, dict) and isinstance(model.get("id"), str) and model["id"]:
                refs.append(f"{provider_id}/{model['id']}")
    return refs


class PiNativeLaunch(NamedTuple):
    """Env, CLI args and any effort notice for a managed pi-native launch.

    :param env: Env vars to merge into the terminal spec.
    :param args: ``--provider``/``--model``/``--thinking`` args to append.
    :param effort_warning: User-facing notice when the requested effort could
        not be honoured; ``None`` otherwise.
    :param rollover_threshold_tokens: The window-derived rollover threshold
        computed here (see ``resolve_rollover_threshold``), when the session
        is a rollover session with a known model context window; ``None``
        otherwise. Callers patch this into the already-written pi-native
        extension config (``bridge.set_rollover_threshold_tokens``) so the
        JS extension compacts at the same point Pi's own settings do.
    """

    env: dict[str, str]
    args: list[str]
    effort_warning: str | None = None
    rollover_threshold_tokens: int | None = None


def _model_context_window(
    rendered: _PiModelsConfig, provider_id: str, model_id: str
) -> int | None:
    """Look up the ``contextWindow`` Pi's rendered models.json carries for a model.

    :param rendered: The rendered Pi models.json (``provider.to_models_config()``).
    :param provider_id: The provider id the model is served from.
    :param model_id: The bare model id within that provider.
    :returns: The known context window, or ``None`` when unrecorded.
    """
    provider_payload = rendered["providers"].get(provider_id)
    if provider_payload is None:
        return None
    for model in provider_payload.get("models", []):
        if isinstance(model, dict) and model.get("id") == model_id:
            window = model.get("contextWindow")
            return window if isinstance(window, int) else None
    return None


def pi_native_provider_launch(
    agent_dir: Path,
    provider: PiProviderConfig,
    reasoning_effort: str | None = None,
    *,
    selection: str | None = None,
    labels: Mapping[str, str] | None = None,
) -> PiNativeLaunch:
    """Write the managed config and return the launch env + CLI args for Pi.

    :param agent_dir: The managed Pi config dir for this session.
    :param provider: The resolved provider config.
    :param reasoning_effort: Canonical omnigent effort for the session, e.g.
        ``"high"``. Passed as ``--thinking`` on the primary provider; ignored
        (with a warning) on a gateway-routed model, whose thinking must stay
        off for text to surface.
    :param selection: Optional picker value naming a generated provider and
        model. When that provider no longer serves the model, the provider that
        does is used instead.
    :param labels: The session's labels. For a rollover session (see
        ``omnigent.context.labels.is_rollover``) with a known model context
        window, writes ``compaction`` settings so Pi's own auto-compaction
        trigger matches Omnigent's rollover threshold instead of Pi's
        defaults. ``None``/non-rollover leaves Pi's compaction settings
        untouched.
    :returns: The launch env, CLI args and any effort warning.
    :raises ValueError: If no generated provider serves the selected model.
    """
    # Render once and reuse: rendering logs how an uncataloged model was routed,
    # and this function both writes the config and reads it back for --provider.
    rendered = provider.to_models_config()
    # Resolve which provider the selected model lives in. Non-Claude models
    # (GLM, GPT, Llama…) are in secondary providers; Claude models are in the
    # primary provider. Read the rendered config so family fallbacks agree.
    selected_model = provider.model
    selection_parts = (
        None if provider.inference_bound else _split_pi_native_model_selection(selection)
    )
    if selection_parts is not None:
        candidate_provider, candidate_model = selection_parts
        serving = [
            provider_id
            for provider_id, configured in rendered["providers"].items()
            if any(model.get("id") == candidate_model for model in configured.get("models", []))
        ]
        if not serving:
            raise ValueError(
                f"Pi model selection {selection!r} is not available in managed configuration"
            )
        # A selection names the provider that served the model when it was
        # picked. The workspace listing may since have routed the model to another
        # surface, or discovery may have failed and folded it back into the
        # primary; follow the model, which the rendered config already routed.
        model_provider_id = candidate_provider if candidate_provider in serving else serving[0]
        selected_model = candidate_model
    else:
        model_provider_id = _default_model_provider_id(provider, rendered)
    write_pi_models_config(agent_dir, provider, rendered)
    # Copy the user's global Pi settings but suppress defaultThinkingLevel.
    # In TUI mode Pi applies the setting from ~/.pi/agent/settings.json; for
    # non-Claude models via openai-completions, any thinking level causes the
    # gateway to return 400 (reasoning_effort is sent even when
    # supportsReasoningEffort is false in the compat block, because TUI mode
    # applies the session-level thinking before the compat check fires).
    # Passing None in the overlay makes _deep_merge_settings write null for the
    # key; Pi's getDefaultThinkingLevel() returns null (falsy) → no thinking.
    from omnigent.inner.pi_settings import prepare_managed_pi_agent_dir

    overlay: dict[str, object] = {"defaultThinkingLevel": None}
    # Only configured shortlists override the user's picker preferences.
    # Qualified refs distinguish managed models from built-in providers.
    enabled_refs = _enabled_model_refs(rendered)
    if provider.curated_models and enabled_refs:
        overlay["enabledModels"] = enabled_refs
    from omnigent.context.labels import is_rollover

    rollover_threshold_tokens: int | None = None
    if is_rollover(labels):
        from omnigent.context.rollover import resolve_keep_tokens, resolve_rollover_threshold

        # The extension compacts at our threshold after each settled turn; Pi
        # must keep our tail size. With a known window, Pi's own trigger
        # (contextTokens > window - reserveTokens) is aligned as well.
        compaction: dict[str, object] = {
            "enabled": True,
            "keepRecentTokens": resolve_keep_tokens(labels),
        }
        context_window = _model_context_window(rendered, model_provider_id, selected_model)
        if context_window is not None:
            rollover_threshold_tokens = resolve_rollover_threshold(
                labels, model_window=context_window
            )
            compaction["reserveTokens"] = max(context_window - rollover_threshold_tokens, 1)
        overlay["compaction"] = compaction
    prepare_managed_pi_agent_dir(agent_dir, overlay=overlay)
    env = {PI_CODING_AGENT_DIR_ENV_VAR: str(agent_dir)}
    if provider.inference_bound:
        env["OMNIGENT_PI_INFERENCE_BOUND"] = "1"
    # When the model id contains a "/" Pi's arg parser splits on the first
    # slash and treats the left part as a provider name, overriding
    # --provider. Pass the fully-qualified "provider/model" reference so Pi's
    # findExactModelReferenceMatch matches the canonical form exactly and
    # routes to our custom provider, not a builtin with the same model id.
    model_arg = (
        f"{model_provider_id}/{selected_model}" if "/" in selected_model else selected_model
    )
    args = ["--provider", model_provider_id, "--model", model_arg]
    thinking: str | None = None
    effort_warning: str | None = None
    if reasoning_effort and reasoning_effort not in EFFORT_CLEAR_VALUES:
        try:
            effort = validate_effort(reasoning_effort, "pi", PI_EFFORTS)
        except ValueError as exc:
            effort = None
            effort_warning = str(exc)
            _LOGGER.warning("pi-native: %s", exc)
        if effort is not None:
            thinking = to_pi_thinking_level(effort)
    # For non-Claude models on openai-completions/responses, disable thinking.
    # Some non-Claude models return reasoning_tokens in their
    # responses; Pi's TUI mode applies thinking even with defaultThinkingLevel:null
    # in settings, causing the agent loop to complete without surfacing the text
    # content to the extension. Explicitly passing --thinking off ensures the
    # completions handler doesn't activate the thinking path.
    if model_provider_id != provider.provider_id:
        args.extend(["--thinking", PI_THINKING_OFF])
        if thinking is not None and thinking != PI_THINKING_OFF:
            effort_warning = (
                f"effort ignored for gateway-routed model {provider.model}: "
                "thinking disabled to keep text surfacing"
            )
            _LOGGER.warning("pi-native: %s", effort_warning)
    elif thinking is not None:
        args.extend(["--thinking", thinking])
    return PiNativeLaunch(
        env=env,
        args=args,
        effort_warning=effort_warning,
        rollover_threshold_tokens=rollover_threshold_tokens,
    )
