"""The one-shot note after a pick (ADR 0035, amended): a warm session holds its own history and
never reads the card the engine appended between turns, so the next turn is told in one line.

The pick marks the Conversation with :data:`PICKED_LABEL_KEY` ``= "<key>\\t<title>"``;
:func:`deliver_topic_pick` (the feature's ``turn_prefix``) turns it into :data:`PICKED_NOTE`
and clears it through the generic labels write (``PATCH /v1/sessions/{id}``). The card stays
the record.
"""

from __future__ import annotations

import logging

import httpx

_logger = logging.getLogger(__name__)

#: The topic the person just picked up, until the next turn reads it.
PICKED_LABEL_KEY = "omnigent.superchat.topics.picked"
#: The one-shot note, filled with the topic's title and key.
PICKED_NOTE = "The person picked up the topic {title} (`{key}`) to continue it."


def picked_value(key: str, title: str) -> str:
    """The label value a pick writes."""
    return f"{key}\t{' '.join(title.split())}"


async def deliver_topic_pick(
    server_client: httpx.AsyncClient | None, conversation_id: str
) -> list[str]:
    """The one-shot "the person picked up this topic" note, cleared once read. Never raises."""
    if server_client is None or not conversation_id:
        return []
    try:
        resp = await server_client.get(
            f"/v1/sessions/{conversation_id}",
            params={
                "include_items": "false",
                "include_liveness": "false",
                "include_usage": "false",
            },
            timeout=10.0,
        )
        labels = resp.json().get("labels") if resp.status_code == 200 else None
    except (httpx.HTTPError, ValueError, AttributeError):
        return []
    picked = labels.get(PICKED_LABEL_KEY, "") if isinstance(labels, dict) else ""
    key, _, title = picked.partition("\t") if isinstance(picked, str) else ("", "", "")
    if not key:
        return []
    try:
        await server_client.patch(
            f"/v1/sessions/{conversation_id}",
            json={"labels": {PICKED_LABEL_KEY: ""}},
            timeout=10.0,
        )
    except httpx.HTTPError:
        _logger.warning(
            "could not clear the topic pick note", extra={"session_id": conversation_id}
        )
    return [PICKED_NOTE.format(title=title or key, key=key)]
