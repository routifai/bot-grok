"""Top-level ``omnigent resume`` dispatch.

Glue layer that converts the user's "take me back to where I was"
intent into a copy-pasteable ``omnigent run --resume`` invocation.

- ``omnigent resume <conv_id>`` — validate the id and print the hint.
- ``omnigent resume`` (no id) — open the cross-agent picker (see
  :func:`omnigent.repl._resume_picker.pick_conversation_cross_agent_from_sdk`)
  and hint the selection the same way.

The agentless ``run --resume`` shape is tracked separately.
"""

from __future__ import annotations

import asyncio
import logging

import click
import httpx

from omnigent.cli_invocation import cli_invocation

_logger = logging.getLogger(__name__)

# Characters a copy-paste commonly drags along around an id (sentence
# punctuation, quoting, brackets). Never valid in any id spelling, so
# stripping them from the ends cannot change which conversation resolves.
_PASTE_PUNCTUATION = " \t`'\"()[]{}<>.,;:"


def run_resume(
    *,
    target: str | None,
    server: str | None,
) -> None:
    """
    Resolve the user's resume request into a resume hint.

    Direct-id form (``target`` provided) is the common CUJ — the user
    knows the conversation they want and types its id. Picker form
    (``target`` is None) requires ``--server`` because starting an empty
    local server just to host the picker would leak state and collide with
    any other in-flight ``omnigent`` process the user has running.

    :param target: Optional conversation id, e.g. ``"conv_abc123"``.
        ``None`` selects the picker form.
    :param server: Optional remote Omnigent server URL. Required in the
        picker form (no agent is supplied so we can't bootstrap a
        local server).
    :returns: None when the picker is cancelled.
    :raises click.UsageError: When the picker form is invoked
        without ``--server`` (the user-facing message names both
        recoverable paths).
    :raises click.ClickException: Carrying the resume hint, or when the
        conversation id is invalid.
    """
    if target is None:
        if server is None:
            raise click.UsageError(
                f"`{cli_invocation()} resume` (no id) requires `--server <url>`. "
                f"Pass a conversation id (`{cli_invocation()} resume conv_...`) "
                "to use the persistent local store.",
            )
        target = _pick_conversation_for_resume(server=server)
        if target is None:
            # Picker cancelled (or no prior conversations on this
            # server). Treat as a clean exit — the user explicitly
            # chose not to pick anything.
            return

    _dispatch_by_runtime(
        target=target,
        server=server,
    )


def _pick_conversation_for_resume(
    *,
    server: str,
) -> str | None:
    """
    Run the cross-agent picker against *server* and return the choice.

    Wires the SDK client up just for the picker call; closes it on
    exit so a long picker hold doesn't keep the connection open.
    Cancellation (user hits ``q`` / Enter on an empty line) and
    empty-list both surface as ``None`` — the caller treats both as
    "no resume requested" and exits cleanly.

    :param server: Remote Omnigent server URL, e.g.
        ``"https://example.databricksapps.com"``.
    :returns: Selected conversation id, or ``None`` on cancel.
    """
    from omnigent.chat import _remote_headers
    from omnigent.repl._resume_picker import pick_conversation_cross_agent_from_sdk

    base_url = server.rstrip("/")
    headers = _remote_headers(server_url=base_url, host_id=None)
    # Resume is owner-only, so the picker lists only the caller's own
    # sessions — never ones merely shared with them. Resolve who the
    # caller is here so the picker can drop shared rows; best-effort, so
    # an unresolved identity just leaves the list unfiltered.
    owner_user_id = _resolve_current_user_id(base_url=base_url, headers=headers)

    async def _drive() -> str | None:
        """
        Open one SDK client, run the picker, close on exit.

        :returns: Selected conversation id, ``None`` on cancel /
            empty list.
        """
        # Deferred import: ``omnigent_client`` carries the full SDK
        # surface and is only needed for the picker, not for every
        # ``omnigent`` invocation.
        from omnigent_client import OmnigentClient

        async with OmnigentClient(base_url=base_url, headers=headers) as client:
            return await pick_conversation_cross_agent_from_sdk(
                client, owner_user_id=owner_user_id
            )

    try:
        return asyncio.run(_drive())
    except click.ClickException:
        raise
    except httpx.HTTPError as exc:
        # Network failure reaching ``server``. Surface a clear error
        # rather than a raw httpx traceback — the user can act on
        # "couldn't reach <url>" but not on a stack frame.
        raise click.ClickException(
            f"Failed to load conversations from {base_url!r}: {exc}",
        ) from exc
    except Exception as exc:
        # Catch-all to translate any other SDK/transport failure into
        # a user-actionable error. Re-raises ``ClickException`` so
        # other Click handlers don't double-wrap.
        raise click.ClickException(
            f"Picker failed against {base_url!r}: {type(exc).__name__}: {exc}",
        ) from exc


def _resolve_current_user_id(
    *,
    base_url: str,
    headers: dict[str, str],
) -> str | None:
    """
    Best-effort ``GET /v1/me`` to learn who the caller is.

    The cross-agent resume picker uses this to drop sessions merely
    *shared* with the caller (resume is owner-only). It is deliberately
    best-effort: a permissionless single-user server answers
    ``user_id: null`` (no sharing — nothing to filter), and a transient
    lookup failure must never break resume. Both fall back to ``None``,
    which the picker reads as "no owner filter". Reuses the same header
    chain the picker's own requests carry, so it authenticates
    identically.

    :param base_url: Remote server URL without a trailing slash.
    :param headers: Request headers (auth) shared with the picker.
    :returns: The caller's ``user_id``, or ``None`` when it can't be
        resolved (unauthenticated, non-200, non-JSON, or unreachable).
    """
    try:
        resp = httpx.get(f"{base_url}/v1/me", headers=headers, timeout=10.0)
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        body = resp.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    user_id = body.get("user_id")
    return user_id if isinstance(user_id, str) and user_id else None


def _dispatch_by_runtime(
    *,
    target: str,
    server: str | None,
) -> None:
    """
    Point the user at the ``omnigent run --resume`` invocation for *target*.

    :param target: Conversation id, e.g. ``"conv_abc123"``.
    :param server: Optional remote Omnigent server URL.
    :raises click.ClickException: Always: with the resume hint, or when
        *target* is not a valid local conversation id.
    """
    from omnigent.db.db_models import InvalidUuidError, uuid_to_bytes

    # Paste punctuation (trailing period, wrapping quotes/backticks) is never
    # part of an id, so strip it. Only the local path binds the id to the sqlite
    # store's Uuid16 column, so it must be a real uuid — reject a malformed one
    # loudly. The remote server owns its id space (a managed deployment keys
    # sessions on non-uuid ids) and validates the id itself.
    stripped = target.strip(_PASTE_PUNCTUATION)
    if server is None:
        try:
            target = uuid_to_bytes(stripped).hex()
        except InvalidUuidError as exc:
            raise click.ClickException("Invalid session id.") from exc
        raise click.ClickException(
            f"To resume {target!r}, run "
            f"`{cli_invocation()} run --resume {target} <agent.yaml>`. "
            "The agentless form is tracked separately.",
        )
    raise click.ClickException(
        f"To resume {stripped!r}, run "
        f"`{cli_invocation()} run --resume {stripped} <agent.yaml> --server "
        f"{server}`. The agentless form is tracked separately.",
    )
