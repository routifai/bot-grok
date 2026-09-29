"""Per-turn deployment context provider hook.

Lets a deployment built on Omnigent (e.g. a product sitting on top of the
runner) inject extra instructions into a session's turn without growing
conversation history — the injected text is appended to the composed system
instructions for the turn, never persisted as a conversation item.

Configured with env vars, read by the **server only** — never by a runner. A
runner can be a user's own laptop (``omnigent host``), which must never hold
the provider secret and may not even be able to reach the provider network;
the runner instead calls ``POST /v1/sessions/{id}/deployment-context`` on the
server (see ``omnigent/server/routes/sessions/routes_core.py``), which
resolves ``user_id``/``labels`` from its own stores and calls this module:

- ``OMNIGENT_CONTEXT_PROVIDER``: ``"nova"`` calls Nova's own context composer
  in-process (:func:`omnigent.nova.context.provide`) — no network hop, no
  secret. Unset, ``"http"``, or any other value keeps the HTTP path below,
  driven by ``OMNIGENT_CONTEXT_PROVIDER_URL``.
- ``OMNIGENT_CONTEXT_PROVIDER_URL``: unset (the default) is a complete
  no-op — nothing is fetched, nothing is appended, and no state is kept.
  Ignored in ``"nova"`` mode.
- ``OMNIGENT_CONTEXT_PROVIDER_SECRET``: sent as ``Authorization: Bearer
  <secret>`` on the HTTP path. May be unset (an empty bearer token is sent)
  but should be set whenever the URL is reachable by anyone other than the
  server. In ``"nova"`` mode there is no request to authenticate, but this
  value (if set) is still passed to the composer to redact, in case it ever
  turns up verbatim in a person's own data.

Contract: ``POST <url>`` with a JSON body of session/turn context (see
:func:`fetch_deployment_context`); a 200 response
``{"instructions": "..."}`` is wrapped in a ``<deployment_context>`` block
and appended to the turn's composed instructions. Nova mode wraps and caps
the composer's output the same way. Any error, timeout, non-200 response, or
(in Nova mode) exception is logged once per session (bounded to an LRU of
``_WARNED_SESSIONS_MAX`` sessions) and otherwise ignored — this hook must
never fail or delay a turn.
"""

from __future__ import annotations

import logging
import os
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# Total request budget (connect + read + write). Short: a slow or wedged
# context provider must not noticeably delay a turn.
_TIMEOUT_S = 2.0

# Matches the contract's truncation of the outgoing ``turn_input`` field.
_MAX_TURN_INPUT_CHARS = 4000

# Cap on the returned instructions text, in bytes of UTF-8. A misbehaving
# or malicious provider must not be able to blow up the prompt.
_MAX_RESPONSE_BYTES = 64 * 1024

_MODE_ENV = "OMNIGENT_CONTEXT_PROVIDER"
_URL_ENV = "OMNIGENT_CONTEXT_PROVIDER_URL"
_SECRET_ENV = "OMNIGENT_CONTEXT_PROVIDER_SECRET"
_NOVA_MODE = "nova"

# Sessions already warned about a failed fetch, so a wedged/unreachable
# provider logs once per session rather than once per turn. Bounded to an
# LRU of _WARNED_SESSIONS_MAX: this endpoint is called by the server (which
# may see far more sessions over its lifetime than a single runner ever
# did), so an unbounded set here would leak memory for the life of the
# process. Least-recently-warned entries are evicted first; a session that
# keeps failing every turn stays warm and never gets evicted.
_WARNED_SESSIONS_MAX = 1024
_warned_sessions: OrderedDict[str, None] = OrderedDict()


def _provider_mode() -> str:
    """The configured provider mode: ``"nova"`` or ``"http"`` (the default).

    Any value other than ``"nova"`` (unset, ``"http"``, or anything else)
    keeps the existing HTTP path, driven by ``_provider_url()`` below.
    """
    return os.environ.get(_MODE_ENV, "").strip().lower() or "http"


def _provider_url() -> str | None:
    """Resolve the configured context-provider URL, or ``None`` when unset."""
    return os.environ.get(_URL_ENV, "").strip() or None


def _wrap(instructions: str) -> str:
    """Wrap deployment-provided text in the fixed delivery marker."""
    return f"\n\n<deployment_context>\n{instructions}\n</deployment_context>"


def _truncate_utf8(text: str, max_bytes: int) -> str:
    """Truncate *text* to at most *max_bytes* UTF-8 bytes, on a valid boundary."""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _warn_once(session_id: str, message: str) -> None:
    """Log *message* at most once per ``session_id`` (see ``_WARNED_SESSIONS_MAX``)."""
    if session_id in _warned_sessions:
        return
    _warned_sessions[session_id] = None
    if len(_warned_sessions) > _WARNED_SESSIONS_MAX:
        _warned_sessions.popitem(last=False)
    logger.warning(message, extra={"session_id": session_id})


def context_provider_configured() -> bool:
    """Whether a context provider is configured (cheap no-op check).

    ``"nova"`` mode is always configured (no URL to check); the HTTP path is
    configured only when its URL is set.
    """
    if _provider_mode() == _NOVA_MODE:
        return True
    return _provider_url() is not None


async def fetch_deployment_context(
    *,
    session_id: str,
    agent_name: str | None,
    harness: str | None,
    user_id: str | None,
    labels: Mapping[str, str] | None,
    turn_input: str | None,
) -> str:
    """Fetch this turn's deployment-injected instructions, wrapped for appending.

    No-op (returns ``""``) when unconfigured (see
    :func:`context_provider_configured`). On any error, timeout, non-200
    response, or (in ``"nova"`` mode) exception, logs a warning once per
    ``session_id`` and returns ``""`` so the turn proceeds unaffected — this
    must never raise.

    :param session_id: Omnigent session/conversation id.
    :param agent_name: The dispatched agent's name/id, e.g. ``"research-agent"``.
    :param harness: Canonical harness name for this turn, e.g. ``"pi"``.
    :param user_id: Authenticated user id, or ``None`` when not resolvable
        at this layer (e.g. header/proxy auth the runner doesn't see).
    :param labels: The session's conversation labels.
    :param turn_input: The latest user message text, or ``None``/``""``.
    :returns: A ``"\\n\\n<deployment_context>...</deployment_context>"``
        block to append to the composed instructions, or ``""`` when
        unconfigured, empty, or unavailable.
    """
    if _provider_mode() == _NOVA_MODE:
        return await _fetch_from_nova(
            session_id=session_id, user_id=user_id, labels=labels, turn_input=turn_input
        )

    url = _provider_url()
    if url is None:
        return ""
    secret = os.environ.get(_SECRET_ENV, "")
    body: dict[str, Any] = {
        "session_id": session_id,
        "agent_name": agent_name or "",
        "harness": harness or "",
        "user_id": user_id,
        "labels": dict(labels) if labels else {},
        "turn_input": (turn_input or "")[:_MAX_TURN_INPUT_CHARS],
    }
    headers = {"Authorization": f"Bearer {secret}"}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            response = await client.post(url, json=body, headers=headers)
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        _warn_once(
            session_id,
            f"context provider request failed for session={session_id} url={url}: {exc}",
        )
        return ""
    instructions = data.get("instructions") if isinstance(data, dict) else None
    if not isinstance(instructions, str) or not instructions:
        return ""
    return _wrap(_truncate_utf8(instructions, _MAX_RESPONSE_BYTES))


async def _fetch_from_nova(
    *,
    session_id: str,
    user_id: str | None,
    labels: Mapping[str, str] | None,
    turn_input: str | None,
) -> str:
    """In-process counterpart to the HTTP path above, for ``OMNIGENT_CONTEXT_PROVIDER=nova``.

    Calls Nova's own context composer directly — no network hop, no secret
    to send — but keeps the same wrap/cap/fail-open contract as the HTTP
    path, so a caller (``routes_core.py``) sees no difference between modes.

    :param session_id: Omnigent session/conversation id.
    :param user_id: The session owner's user id, resolved by the caller; not
        taken from the runner.
    :param labels: The session's conversation labels.
    :param turn_input: The latest user message text, or ``None``/``""``.
    :returns: The wrapped, capped block, or ``""`` on any failure or when
        Nova has nothing to add.
    """
    from omnigent.db.db_models import current_workspace_id
    from omnigent.nova.context import provide

    secret = os.environ.get(_SECRET_ENV, "")
    try:
        instructions = await provide(
            owner_user_id=user_id,
            labels=labels or {},
            turn_input=turn_input or "",
            session_id=session_id,
            workspace_id=current_workspace_id(),
            secrets=(secret,) if secret else (),
        )
    except Exception as exc:  # this hook must never fail a turn
        _warn_once(session_id, f"Nova context provider failed for session={session_id}: {exc}")
        return ""
    if not instructions:
        return ""
    return _wrap(_truncate_utf8(instructions, _MAX_RESPONSE_BYTES))


def forget_session(session_id: str) -> None:
    """Drop the warn-once bookkeeping for a finished/evicted session."""
    _warned_sessions.pop(session_id, None)


def extract_turn_input_text(content: object) -> str:
    """Best-effort extraction of the latest user message text from a turn's
    raw ``content`` field, for the context-provider ``turn_input`` value.

    Accepts a plain string, a flat list of content blocks (``{"type":
    "input_text", "text": "..."}``), or a list of role-keyed message-shaped
    items (``{"role": "user", "content": "..."}`` or ``{"role": "user",
    "content": [{"text": "..."}]}``) — the shapes a turn's forwarded message
    content takes across callers. Non-``user`` roles are skipped so a
    function-call/tool-output entry never shadows the real prompt.

    :param content: The turn's raw content value.
    :returns: The latest user message text, or ``""`` when none is found.
    """
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    if any(isinstance(item, dict) and "role" in item for item in content):
        # Message-history shape: each top-level item is one message; find
        # the latest one authored by the user.
        last_text = ""
        for item in content:
            if isinstance(item, dict) and item.get("role") == "user":
                last_text = _message_content_text(item.get("content"))
        return last_text
    # Flat content-block shape: every block belongs to the single message.
    return _message_content_text(content)


def _message_content_text(content: object) -> str:
    """Join the ``text`` fields of one message's content blocks."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict) and isinstance(block.get("text"), str)
    ]
    return "\n".join(parts)
