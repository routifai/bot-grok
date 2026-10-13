"""Rollover for superside-chat sessions on the Claude SDK engine (S2).

A superside-chat session (Super Chat, Side Chat, or Sub-agent alike) rolls
over at two points — see ``rollover/SUPERSIDE-CHAT-PLAN.md`` S2 and the
**Rollover** term in ``rollover/CONTEXT.md``:

- the engine-reported context size crosses :func:`~omnigent.context.rollover.
  resolve_rollover_threshold` after a turn (:func:`should_roll_over_for_threshold`);
- the session's first message after being idle past
  :func:`resolve_idle_refresh_seconds` (:func:`should_roll_over_for_idle`), but only
  when the items since the last checkpoint no longer fit the kept-tail budget; otherwise
  the return is a cold start from the stored checkpoint with no summarizer call.

Either trigger runs the same action (:func:`roll_over_session`): build the
next rollover item over this session's record since the latest ``compaction``
item (reusing :func:`~omnigent.context.rollover.build_rollover_item`'s
progressive summarization), POST it as a new ``compaction`` item, then signal
the caller to drop the warm engine client so the next turn cold-starts from
it (``ADR 0001``: Omnigent decides when, the engine only runs the model loop).
Never during a turn — both call sites in ``inner/claude_sdk_executor.py`` and
``runner/app.py`` trigger only between turns.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any

import httpx

from omnigent.context.labels import is_superside_chat
from omnigent.context.rollover import (
    CheckpointCause,
    build_rollover_item,
    is_placeholder_summary,
    reported_context_window,
    resolve_keep_tokens,
    resolve_rollover_threshold,
    split_at_latest_compaction,
)
from omnigent.context.state_file import close_label_key, pending_closes
from omnigent.entities import CompactionData

logger = logging.getLogger(__name__)

#: Idle period before a superside-chat session refreshes on return. Lower it
#: (e.g. a few seconds) for testing.
OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS_ENV = "OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS"

#: 12 hours.
DEFAULT_IDLE_REFRESH_SECONDS = 43_200


def resolve_idle_refresh_seconds() -> int:
    """Resolve the idle period before a superside-chat session refreshes on return.

    Reads :data:`OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS_ENV`, default
    :data:`DEFAULT_IDLE_REFRESH_SECONDS` (12 hours). A missing, non-integer,
    or non-positive value falls back to the default.
    """
    raw = os.environ.get(OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS_ENV)
    if raw is None:
        return DEFAULT_IDLE_REFRESH_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_IDLE_REFRESH_SECONDS
    return value if value > 0 else DEFAULT_IDLE_REFRESH_SECONDS


def should_roll_over_for_threshold(
    labels: Mapping[str, str] | None,
    *,
    context_tokens: int | None,
    model_window: int | None = None,
) -> bool:
    """Whether a superside-chat turn's reported context size hit the rollover threshold.

    ``False`` for a non-superside-chat session or when *context_tokens* is
    ``None`` (the turn carried no window-fill signal).

    :param labels: The session's labels.
    :param context_tokens: The turn's reported window fill (e.g.
        ``usage.context_tokens`` from a claude-sdk ``ResultMessage``), or
        ``None``.
    :param model_window: The session's model's context window, forwarded to
        :func:`~omnigent.context.rollover.resolve_rollover_threshold`.
    """
    if not is_superside_chat(labels) or context_tokens is None:
        return False
    return context_tokens >= resolve_rollover_threshold(labels, model_window=model_window)


#: Fraction of the model's context window at which another turn would overflow
#: it. At or past this fill the next turn waits (bounded) for an in-flight
#: rollover; below it, turns never wait on the summarizer.
HARD_CONTEXT_WINDOW_FRACTION = 0.95


def exceeds_hard_context_limit(
    labels: Mapping[str, str] | None,
    *,
    context_tokens: int | None,
) -> bool:
    """Whether *context_tokens* is at/over the hard fraction of the session's window.

    ``False`` when the tokens or the session's reported window are unknown.
    """
    window = reported_context_window(labels)
    if context_tokens is None or window is None:
        return False
    return context_tokens >= int(window * HARD_CONTEXT_WINDOW_FRACTION)


def should_roll_over_for_idle(
    labels: Mapping[str, str] | None,
    *,
    idle_seconds: float | None,
) -> bool:
    """Whether a superside-chat session has been idle long enough to refresh on return.

    ``False`` for a non-superside-chat session or when *idle_seconds* is
    ``None`` (no prior activity to compare against — e.g. the session's
    first ever turn).

    :param labels: The session's labels.
    :param idle_seconds: Seconds since the session's last recorded activity,
        or ``None``.
    """
    if not is_superside_chat(labels) or idle_seconds is None:
        return False
    return idle_seconds >= resolve_idle_refresh_seconds()


# ---------------------------------------------------------------------------
# Build + persist the next rollover item
# ---------------------------------------------------------------------------

# Sessions with a rollover build+post currently in flight. Module-level,
# process-lifetime: a second trigger for the same session (the threshold
# check and the idle-refresh check can both fire around the same turn) is a
# no-op rather than racing the first — see :func:`roll_over_session`.
_in_flight: set[str] = set()


class ItemsPageFetchError(Exception):
    """A page of ``GET .../items`` came back non-200 while scanning for rollover."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


#: Page size when reading the record from the checkpoint on (the route's maximum).
_RECORD_PAGE_LIMIT = "1000"
#: Page size when looking up the latest checkpoint (compaction items are rare).
_COMPACTION_LOOKUP_LIMIT = "20"


async def _get_items_page(
    server_client: httpx.AsyncClient, conversation_id: str, params: dict[str, str]
) -> dict[str, Any]:
    """One ``GET /v1/sessions/{id}/items`` page.

    :raises ItemsPageFetchError: the route answered non-200.
    """
    resp = await server_client.get(
        f"/v1/sessions/{conversation_id}/items", params=params, timeout=10.0
    )
    if resp.status_code != 200:
        raise ItemsPageFetchError(
            f"GET items for {conversation_id!r} returned {resp.status_code}", resp.status_code
        )
    return resp.json()


async def fetch_latest_checkpoint(
    server_client: httpx.AsyncClient,
    conversation_id: str,
    *,
    skip_placeholders: bool = False,
) -> dict[str, Any] | None:
    """The session's latest ``compaction`` item, or ``None`` when it has none.

    With *skip_placeholders*, a compaction whose summary is a harness stand-in
    (:func:`~omnigent.context.rollover.is_placeholder_summary`) holds no state
    and is passed over for the previous real one.

    :raises ItemsPageFetchError: a page came back non-200.
    """
    params = {"limit": _COMPACTION_LOOKUP_LIMIT, "order": "desc", "type": "compaction"}
    while True:
        page = await _get_items_page(server_client, conversation_id, params)
        data = page.get("data", [])
        for item in data:
            if item.get("type") != "compaction":
                continue
            if skip_placeholders and is_placeholder_summary(item.get("summary")):
                continue
            return item
        if not data or not page.get("has_more", False):
            return None
        params = {**params, "after": data[-1]["id"]}


async def iter_items_from_checkpoint(
    server_client: httpx.AsyncClient,
    conversation_id: str,
    *,
    skip_placeholders: bool = False,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Page the record from the latest checkpoint on, not from item 1.

    Yields pages (``limit=1000``, oldest first) that
    :func:`~omnigent.context.rollover.split_at_latest_compaction` splits exactly
    as it would split the whole record. A checkpoint's ``last_item_id`` is the
    last item it summarized; its kept tail lives in its own
    ``compacted_messages``, so the items still needed are the ones after that
    anchor (turns that ran while the summarizer worked, the compaction item
    itself, and everything since). The first page therefore starts after the
    anchor and carries a stand-in ``{"id": anchor}`` item in front, which is
    the only thing the split reads from it. An anchor the record does not hold
    (a native forwarder's synthetic id) reads after the compaction item
    instead, with the item itself in front. With no checkpoint the record is
    read from the start, as before. Placeholder checkpoints (see
    :func:`fetch_latest_checkpoint`) are left out of the yielded pages.

    :raises ItemsPageFetchError: a page came back non-200.
    """
    checkpoint = await fetch_latest_checkpoint(
        server_client, conversation_id, skip_placeholders=skip_placeholders
    )
    anchor = checkpoint.get("last_item_id") if checkpoint is not None else None
    prefix: list[dict[str, Any]] = []
    after: str | None = None
    if checkpoint is not None:
        after = anchor or checkpoint["id"]
        prefix = [{"id": anchor}] if anchor else [checkpoint]
    first = True
    while True:
        params = {"limit": _RECORD_PAGE_LIMIT, "order": "asc"}
        if after is not None:
            params["after"] = after
        try:
            page = await _get_items_page(server_client, conversation_id, params)
        except ItemsPageFetchError as exc:
            if first and anchor and exc.status_code == 400:
                after, anchor, prefix = checkpoint["id"], None, [checkpoint]
                continue
            raise
        data = page.get("data", [])
        if data:
            after = data[-1].get("id")
        if skip_placeholders:
            data = [
                it
                for it in data
                if not (
                    it.get("type") == "compaction" and is_placeholder_summary(it.get("summary"))
                )
            ]
        if data or (first and anchor is None and prefix):
            yield prefix + data
            prefix = []
        first = False
        if not page.get("data") or not page.get("has_more", False):
            return


async def _fetch_items_since_last_compaction(
    server_client: httpx.AsyncClient,
    conversation_id: str,
) -> tuple[list[dict[str, Any]], str | None, str | None]:
    """Read this session's record from its latest checkpoint and split it there.

    Reads through :func:`iter_items_from_checkpoint`, the same anchored read
    ``_load_history_as_input`` (``runner/app.py``) uses to cold-start a
    session, so a rollover costs the size of the epoch, not of the session. A
    placeholder checkpoint is not state: the read goes back to the previous
    real one, so the summary is carried forward and the turns a placeholder
    covered are summarized again.

    :returns: ``(items_since, previous_summary, previous_compaction_id)`` —
        the chronological items after the latest real ``compaction`` item (the
        whole record when there is none), that item's summary text, and its
        item id (all ``None`` for the session's first rollover).
    :raises ItemsPageFetchError: a page came back non-200 — the scan is
        incomplete, so the caller must not treat the partial result as the
        full record since the last compaction.
    """
    items: list[dict[str, Any]] = []
    async for page_items in iter_items_from_checkpoint(
        server_client, conversation_id, skip_placeholders=True
    ):
        items.extend(page_items)
    items_since, checkpoint = split_at_latest_compaction(items)
    if checkpoint is None:
        return items, None, None
    return items_since, checkpoint.get("summary"), checkpoint.get("id")


def _compaction_event_body(
    compaction: CompactionData, *, expected_previous_compaction_id: str | None
) -> dict[str, Any]:
    """Shape a :class:`CompactionData` into the ``POST .../events`` ``data`` body.

    Matches the shape ``runner/app.py``'s ``_handle_harness_compaction``
    posts for a native CLI's own compaction, so both producers write the
    same ``compaction`` item shape. ``expected_previous_compaction_id`` is
    the cross-process single-flight guard: the server rejects (409) this
    write if the session's latest compaction item id has since moved —
    always set (``None`` is a valid expectation: "no prior compaction"),
    so two processes racing the session's very first rollover are guarded
    too, not just later ones.
    """
    body: dict[str, Any] = {
        "type": "compaction",
        "summary": compaction.summary,
        "last_item_id": compaction.last_item_id,
        "model": compaction.model,
        "token_count": compaction.token_count,
        "expected_previous_compaction_id": expected_previous_compaction_id,
    }
    if compaction.compacted_messages:
        body["compacted_messages"] = compaction.compacted_messages
    for name in ("journal_lines", "evicted_entries", "applied_closes", "repairs"):
        value = getattr(compaction, name)
        if value is not None:
            body[name] = value
    return body


def summarizer_model(
    model: str, connection: Mapping[str, str] | None, wire: str | None = None
) -> str:
    """
    The model string the summarizer is called with: provider-prefixed.

    A harness reports its model bare (``claude-sonnet-5-5``), and the LLM router reads a bare
    name as OpenAI's. When the session's own connection is known, its *wire* decides (the
    session's provider speaks Anthropic Messages, or Chat Completions), whatever the model is
    called: ``team-model`` on an Anthropic-wire connection is an Anthropic call. Without one (a
    session with no saved inference binding), a bare Claude model, or any bare model on an
    Anthropic base URL, is routed to the Anthropic adapter; anything already prefixed is left
    as it is.

    :param model: The turn's reported model.
    :param connection: The summarizer's connection overrides, if any.
    :param wire: The LLM client provider the session's connection speaks (``anthropic``,
        ``openai_compatible`` or ``openai``), from
        :func:`omnigent.llms.background.provider_connection`; ``None`` when unknown.
    :returns: ``provider/model``.
    """
    if wire is not None:
        return f"{wire}/{model}"
    if "/" in model:
        return model
    base_url = (connection or {}).get("base_url", "")
    if model.startswith("claude") or "anthropic.com" in base_url:
        return f"anthropic/{model}"
    return model


async def _clear_closes(
    server_client: httpx.AsyncClient, conversation_id: str, closes: Mapping[str, str]
) -> None:
    """Empty the ``state_close`` labels the stored checkpoint consumed. Best effort.

    Labels are upsert-only, so "cleared" is an empty value. A failure leaves the close pending,
    which the next checkpoint finds already closed: harmless.
    """
    consumed = {close_label_key(tag): "" for tag in closes}
    if not consumed:
        return
    try:
        await server_client.patch(
            f"/v1/sessions/{conversation_id}", json={"labels": consumed}, timeout=10.0
        )
    except (httpx.HTTPError, RuntimeError):
        logger.warning(
            "superside-chat rollover: failed to clear applied closes for %s",
            conversation_id,
            exc_info=True,
        )


async def roll_over_session(
    conversation_id: str,
    *,
    labels: Mapping[str, str] | None,
    model: str,
    server_client: httpx.AsyncClient,
    llm_client: Any = None,
    connection: dict[str, str] | None = None,
    on_rolled_over: Callable[[], Awaitable[None]] | None = None,
    wire: str | None = None,
    cause: CheckpointCause = "size",
    on_stored: Callable[[CompactionData], Awaitable[None]] | None = None,
) -> bool:
    """Build and persist the next rollover compaction item for *conversation_id*.

    Fetches this session's record since the latest ``compaction`` item
    (progressive summarization reuses that item's summary —
    :func:`~omnigent.context.rollover.build_rollover_item`), builds the next
    rollover item, and POSTs it as a new ``compaction`` item
    (``POST /v1/sessions/{id}/events``). On success, calls *on_rolled_over* —
    the caller's hook to drop the warm engine client so the next turn
    cold-starts from the new item (e.g. releasing the claude-sdk harness
    subprocess, which runs ``ClaudeSDKExecutor.close_session`` on teardown).

    Single-flight per *conversation_id*: a call that arrives while another is
    already building for the same session returns ``False`` immediately
    rather than racing it. Every failure (history load, summarization, the
    POST, or *on_rolled_over* itself) is logged and swallowed — the turn that
    triggered this call has already been delivered, so a rollover failure
    must never fail it.

    *connection* and *wire* are the session's own provider (see :func:`summarizer_model`): the
    summary is written through the connection the session runs on. *cause* says why the
    checkpoint is made (size, return after idle, manual ``/compact``); it names the reason in
    the checkpoint's header. *on_stored* gets the stored item (its journal lines and evicted
    entries) once it is persisted, before *on_rolled_over*; a failure in it is logged and
    swallowed.

    :returns: ``True`` iff a new compaction item was posted.
    """
    if conversation_id in _in_flight:
        return False
    _in_flight.add(conversation_id)
    try:
        try:
            (
                items_since,
                previous_summary,
                previous_compaction_id,
            ) = await _fetch_items_since_last_compaction(server_client, conversation_id)
        except (httpx.HTTPError, ValueError, ItemsPageFetchError):
            logger.warning(
                "superside-chat rollover: failed to load history for %s",
                conversation_id,
                exc_info=True,
            )
            return False
        if not items_since:
            return False
        closes = pending_closes(labels)
        try:
            compaction = await build_rollover_item(
                items_since,
                previous_summary=previous_summary,
                keep_tokens=resolve_keep_tokens(labels),
                model=summarizer_model(model, connection, wire),
                llm_client=llm_client,
                connection=connection,
                conversation_id=conversation_id,
                cause=cause,
                pending_closes=closes,
            )
        except Exception:  # noqa: BLE001 — a rollover failure must never fail the turn
            logger.warning(
                "superside-chat rollover: failed to build the rollover item for %s",
                conversation_id,
                exc_info=True,
            )
            return False
        try:
            resp = await server_client.post(
                f"/v1/sessions/{conversation_id}/events",
                json={
                    "type": "compaction",
                    "data": _compaction_event_body(
                        compaction,
                        expected_previous_compaction_id=previous_compaction_id,
                    ),
                },
                timeout=10.0,
            )
        except (httpx.HTTPError, RuntimeError):
            logger.warning(
                "superside-chat rollover: failed to persist the rollover item for %s",
                conversation_id,
                exc_info=True,
            )
            return False
        if resp.status_code == 409:
            # Someone else (another runner process for this same session)
            # already rolled over past the checkpoint this summary was
            # built from — not a failure, just a lost race.
            return False
        if resp.status_code < 200 or resp.status_code >= 300:
            logger.warning(
                "superside-chat rollover: persisting the rollover item for %s "
                "returned %s, not dropping the warm client",
                conversation_id,
                resp.status_code,
            )
            return False
        await _clear_closes(server_client, conversation_id, closes)
        if on_stored is not None:
            try:
                await on_stored(compaction)
            except Exception:  # noqa: BLE001 — the item is already persisted; log and move on
                logger.warning(
                    "superside-chat rollover: on_stored failed for %s",
                    conversation_id,
                    exc_info=True,
                )
        if on_rolled_over is not None:
            try:
                await on_rolled_over()
            except Exception:  # noqa: BLE001 — the item is already persisted; log and move on
                logger.warning(
                    "superside-chat rollover: failed to drop the warm client for %s",
                    conversation_id,
                    exc_info=True,
                )
        return True
    finally:
        _in_flight.discard(conversation_id)
