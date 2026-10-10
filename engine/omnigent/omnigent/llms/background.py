"""The model the engine itself calls for background work, and how to reach it.

Background work (memory upkeep, a summary when the session's runner is away) is a server-side
model call. A deployment either names that model in its server config (``llm:``, the static
answer) or registers a *resolver* (:func:`register_background_llm`) that answers from its own
state: Superchat answers with the organization's chosen fast model over the person's (or the
organization's) model connection, so no model name lives in configuration.

:func:`provider_llm_route` is the one rule for calling a model through a configured provider:
the wire comes from the provider's families (Anthropic Messages when it has an ``anthropic``
family, else its OpenAI-compatible endpoint), never from the model's name.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

_logger = logging.getLogger(__name__)

#: ``(model string for the LLM client, connection params or None)``.
BackgroundLLM = tuple[str, dict[str, str] | None]
BackgroundResolver = Callable[[str | None], Awaitable[BackgroundLLM | None]]

_resolver: BackgroundResolver | None = None


def register_background_llm(resolver: BackgroundResolver | None) -> None:
    """Register the deployment's background-model resolver (``None`` unregisters).

    The resolver takes the owner the work is for (``None`` for the organization) and returns
    the model and connection, or ``None`` when no model can be called yet.
    """
    global _resolver
    _resolver = resolver


async def resolve_background_llm(owner_id: str | None = None) -> BackgroundLLM | None:
    """The model and connection background work for *owner_id* runs on, or ``None``.

    The server config's static ``llm:`` block wins when present; otherwise the registered
    resolver answers. A resolver failure is logged and reads as ``None`` (the work is skipped,
    never failed).
    """
    from omnigent.runtime import get_caps

    server_llm = get_caps().llm
    if server_llm is not None:
        from omnigent.runtime.policies.builder import (
            _normalize_policy_model,
            _resolve_server_llm_connection,
        )

        return _normalize_policy_model(server_llm.model), _resolve_server_llm_connection(
            server_llm
        )
    resolver = _resolver
    if resolver is None:
        return None
    try:
        return await resolver(owner_id)
    except Exception:
        _logger.warning("background model could not be resolved", exc_info=True)
        return None


def _family_token(family: Any) -> str | None:
    """The credential a provider family authenticates with: its key, else its command's output."""
    if family.api_key:
        return str(family.api_key)
    if family.auth_command:
        from omnigent.models.model_catalog import ResolvedModelProvider, _resolve_bearer_token

        return _resolve_bearer_token(
            ResolvedModelProvider(kind="gateway", auth_command=family.auth_command)
        )
    return None


def _versioned(base_url: str) -> str:
    """An Anthropic base URL in the Claude SDK form (no ``/v1``) as the LLM client wants it."""
    trimmed = base_url.rstrip("/")
    return trimmed if trimmed.endswith("/v1") else f"{trimmed}/v1"


def provider_connection(provider: Any) -> tuple[str, dict[str, str]] | None:
    """The wire and connection to call a configured *provider* (an ``onboarding`` ProviderEntry).

    The wire is the provider's: its ``anthropic`` family (Anthropic Messages) when it has one,
    else its ``openai`` family (Chat Completions, or the Responses API when that family says
    ``wire_api: responses``).

    :returns: ``(LLM client provider prefix, {"api_key", "base_url"})``: the prefix is
        ``anthropic``, ``openai_compatible`` or ``openai``; ``None`` when the provider has no
        family the LLM client can call.
    """
    anthropic = provider.family("anthropic")
    if anthropic is not None and anthropic.base_url:
        token = _family_token(anthropic)
        connection = {"base_url": _versioned(anthropic.base_url)}
        if token:
            connection["api_key"] = token
        return "anthropic", connection
    openai = provider.family("openai")
    if openai is not None and openai.base_url:
        token = _family_token(openai)
        connection = {"base_url": openai.base_url.rstrip("/")}
        if token:
            connection["api_key"] = token
        return ("openai" if openai.wire_api == "responses" else "openai_compatible"), connection
    return None


def provider_llm_route(provider: Any, model: str) -> BackgroundLLM | None:
    """How to call *model* through a configured *provider*: :func:`provider_connection`'s wire,
    with the model id passed through as the provider names it.

    :returns: ``(model string, connection)``, or ``None`` when the provider cannot be called.
    """
    route = provider_connection(provider)
    if route is None:
        return None
    wire, connection = route
    return f"{wire}/{model}", connection
