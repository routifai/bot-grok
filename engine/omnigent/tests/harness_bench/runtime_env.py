"""Resolve the runtime environment used by harness bench processes."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class BenchRuntimeEnv:
    """The environment a bench server/runner/host-daemon is spawned with.

    :param base_env: The full env dict (``os.environ``, including the ambient
        ``OPENAI_*`` gateway credentials when present).
    :param db_profile: Always ``None``: gateway auth comes only from the
        ambient env. The field is retained for the bench callers that still
        read it.
    """

    base_env: dict[str, str]
    db_profile: str | None


def resolve_bench_env(
    explicit_profile: str | None, *, require_gateway: bool = True
) -> BenchRuntimeEnv:
    """Build the bench runtime env from the ambient gateway credentials.

    Gateway auth is the ambient ``OPENAI_BASE_URL`` + ``OPENAI_API_KEY`` pair;
    there is no credential minting.

    :param explicit_profile: Ignored; retained for the bench callers that
        still pass the ``--profile`` value.
    :param require_gateway: When ``False`` — an ``own_auth`` native harness that
        authenticates its own model (agy, cursor, …) — missing ambient creds are
        tolerated: the server boots with no ``OPENAI_*`` rather than raising,
        since a native-tui turn never routes through the gateway.
    :returns: A :class:`BenchRuntimeEnv`.
    :raises OSError: When ``require_gateway`` and no ambient ``OPENAI_*`` covers
        auth (surfaced by the caller as a clean skip).
    """
    base = dict(os.environ)
    have_ambient = bool(base.get("OPENAI_BASE_URL")) and bool(base.get("OPENAI_API_KEY"))
    if not have_ambient and require_gateway:
        raise OSError(
            "no gateway creds: export OPENAI_API_KEY + OPENAI_BASE_URL to run the live bench"
        )
    return BenchRuntimeEnv(base_env=base, db_profile=None)


def bench_creds_skip_reason(
    explicit_profile: str | None, *, require_gateway: bool = True
) -> str | None:
    """Cheap gate: why the bench cannot get gateway creds, or ``None`` if it can.

    Mirrors :func:`resolve_bench_env`'s precedence so a driver's
    ``unavailable()`` can skip a live run cleanly (no creds) rather than fail
    mid-provision.

    :param explicit_profile: Ignored; retained for the bench callers that
        still pass the ``--profile`` value.
    :param require_gateway: When ``False`` — an ``own_auth`` native harness that
        authenticates its own model — the gateway is optional, so a missing
        credential is never a skip: the harness's own turns don't route through
        it. Mirrors :func:`resolve_bench_env`'s ``require_gateway``.
    :returns: A skip reason, or ``None`` when creds are present (or not
        required).
    """
    if not require_gateway:
        return None
    if os.environ.get("OPENAI_BASE_URL") and os.environ.get("OPENAI_API_KEY"):
        return None
    return "no gateway creds: export OPENAI_API_KEY + OPENAI_BASE_URL"


__all__ = ["BenchRuntimeEnv", "bench_creds_skip_reason", "resolve_bench_env"]
