"""Host-side checks for whether a harness family's inference is AI-Gateway-backed.

Smart Routing's apply layer can only rewrite a launch's model when the launch
resolves through an AI Gateway that serves the routable model catalog. The host
reports the answer per harness family alongside harness readiness on every
registration.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Final

# Every spelling the Claude family travels under on the wire.
CLAUDE_GATEWAY_HARNESSES: Final[tuple[str, ...]] = ("claude-native", "native-claude")

# Every spelling the Codex family travels under on the wire.
CODEX_GATEWAY_HARNESSES: Final[tuple[str, ...]] = ("codex", "codex-native", "native-codex")


def gateway_inference_map() -> dict[str, bool]:
    """Per-harness map of whether this host's inference for that family is gateway-backed.

    This build ships no routable AI Gateway model catalog, so every family
    reports ``False``: Smart Routing's apply layer never rewrites a launch's
    model. The map still fans out over every spelling a family travels under
    so the server can answer for any of them.

    :returns: Harness spelling → gateway-backed flag.
    """
    return dict.fromkeys((*CLAUDE_GATEWAY_HARNESSES, *CODEX_GATEWAY_HARNESSES), False)


def gateway_inference_state(
    gateway: Mapping[str, object] | None,
    harness: str,
) -> bool | None:
    """Read *harness*'s gateway-backed flag out of a reported map.

    :param gateway: A host's ``gateway_inference`` map, or ``None``.
    :param harness: Harness id in any spelling, e.g. ``"native-codex"``.
    :returns: The reported flag, or ``None`` when the map says nothing about
        this harness — an older host, a family whose check could not run, or a
        host that has not registered yet. Unknown is not "unavailable".
    """
    if not gateway:
        return None
    for key in _family_spellings(harness):
        value = gateway.get(key)
        if isinstance(value, bool):
            return value
    return None


def _family_spellings(harness: str) -> tuple[str, ...]:
    """Every key a host may have reported *harness*'s family under.

    :func:`gateway_inference_map` fans one family verdict out over all of its
    spellings, but a caller holds only one — and the reversed aliases
    (``native-codex``) never canonicalize back. Look the family up instead, so
    any spelling finds the entry.

    :param harness: Harness id in any spelling, e.g. ``"native-codex"``.
    :returns: The family's spellings, or just *harness* when it is in neither.
    """
    from omnigent.harness_aliases import canonicalize_harness

    canonical = canonicalize_harness(harness) or harness
    for spellings in (CLAUDE_GATEWAY_HARNESSES, CODEX_GATEWAY_HARNESSES):
        if canonical in spellings or harness in spellings:
            return spellings
    return (canonical, harness)


def not_gateway_backed(
    gateway: Mapping[str, object] | None,
    harnesses: Iterable[str],
) -> list[str]:
    """Which of *harnesses* the map explicitly reports as not gateway-backed.

    Smart Routing's apply layer rewrites the launch model through the AI
    Gateway, so these are the harnesses a routed pick could not reach. Only an
    explicit ``False`` counts: unknown keeps every option.

    :param gateway: A host's ``gateway_inference`` map, or ``None``.
    :param harnesses: Harness ids to check, e.g.
        ``("claude-native", "codex-native")``.
    :returns: The not-backed ids, in the order given.
    """
    return [harness for harness in harnesses if gateway_inference_state(gateway, harness) is False]
