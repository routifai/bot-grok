"""Text helpers for anything that ends up in a model's context."""

from __future__ import annotations

from collections.abc import Iterable


def cap_utf8(text: str, max_bytes: int) -> str:
    """Trim ``text`` to at most ``max_bytes`` of UTF-8, ending on a whole line.

    Never splits a character, and drops a partial last line rather than
    cutting a sentence mid-way.

    :param text: The text to trim.
    :param max_bytes: The budget in bytes.
    :returns: The trimmed text (unchanged when it already fits).
    """
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    head = encoded[:max_bytes].decode("utf-8", errors="ignore")
    cut = head.rfind("\n")
    return head[:cut] if cut > 0 else head


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every occurrence of each secret with ``[redacted]``.

    :param text: The text to clean.
    :param secrets: Secret values; empty strings are ignored.
    :returns: The cleaned text.
    """
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    return text
