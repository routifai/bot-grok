"""``POST /v1/sessions/{id}/side_chats`` — open a Side Chat from its Super Chat.

The one implementation behind the web app's "+ New side chat" and the
``side_chat_open`` tool (``omnigent.runner.tool_dispatch.
_execute_side_chat_open``, tested against a mocked route in
``tests/runner/test_side_chat_tool_dispatch.py``). Exercised here against
the real app because the route itself calls the real fork / create /
events routes in-process (``omnigent.server.routes.sessions.
side_chats.routes._internal_call``).
"""

from __future__ import annotations

import httpx
import pytest

from omnigent.context.labels import CONTEXT_MODE_LABEL, SUPERSIDE_CHAT_MODE_VALUE
from omnigent.stores.conversation_store import (
    FORK_SOURCE_LABEL_KEY,
    SIDE_CHAT_LABEL_KEY,
    SIDE_CHAT_PARENT_LABEL_KEY,
    SIDE_CHAT_START_LABEL_KEY,
)
from tests.server.helpers import create_test_agent

pytestmark = pytest.mark.asyncio


async def _create_super_chat(
    client: httpx.AsyncClient, name: str, *, initial_message: str | None = None
) -> str:
    agent = await create_test_agent(client, name=name)
    body: dict[str, object] = {
        "agent_id": agent["id"],
        "labels": {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE},
    }
    if initial_message is not None:
        # Seeded at create time, not via a later events POST: this harness
        # has no bound runner, and an events POST to an unbound session
        # 503s on the runner-dispatch step (see
        # test_side_chat_unarchive_on_message.py) even though the item
        # itself persists first. initial_items avoids that 503 entirely.
        body["initial_items"] = [
            {
                "type": "message",
                "data": {
                    "role": "user",
                    "content": [{"type": "input_text", "text": initial_message}],
                },
            }
        ]
    resp = await client.post("/v1/sessions", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# ── with_context ───────────────────────────────────────────────────────


async def test_with_context_forks_and_stamps_start_label(client: httpx.AsyncClient) -> None:
    # The fork's rollover seed needs at least one item in the parent record.
    super_chat_id = await _create_super_chat(
        client, "side-chats-with-context", initial_message="let's talk about the roadmap"
    )

    resp = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "with_context", "title": "Roadmap aside"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["start"] == "with_context"
    assert body["title"] == "Roadmap aside"
    new_id = body["conversation_id"]
    assert new_id != super_chat_id

    labels_resp = await client.get(f"/v1/sessions/{new_id}/labels")
    assert labels_resp.status_code == 200, labels_resp.text
    labels = labels_resp.json()["labels"]
    assert labels[SIDE_CHAT_LABEL_KEY] == "1"
    assert labels[SIDE_CHAT_START_LABEL_KEY] == "with_context"
    assert labels[SIDE_CHAT_PARENT_LABEL_KEY] == super_chat_id


# ── blank ──────────────────────────────────────────────────────────────


async def test_blank_creates_top_level_session_and_stamps_start_label(
    client: httpx.AsyncClient,
) -> None:
    super_chat_id = await _create_super_chat(client, "side-chats-blank")

    resp = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "blank", "title": "Unrelated spreadsheet question"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["start"] == "blank"
    assert body["title"] == "Unrelated spreadsheet question"
    new_id = body["conversation_id"]

    labels_resp = await client.get(f"/v1/sessions/{new_id}/labels")
    assert labels_resp.status_code == 200, labels_resp.text
    labels = labels_resp.json()["labels"]
    assert labels[SIDE_CHAT_LABEL_KEY] == "1"
    assert labels[SIDE_CHAT_START_LABEL_KEY] == "blank"
    # Not a fork: no native-fork directive, just the Side Chat's own parent link.
    assert FORK_SOURCE_LABEL_KEY not in labels
    assert labels[SIDE_CHAT_PARENT_LABEL_KEY] == super_chat_id
    assert labels[CONTEXT_MODE_LABEL] == SUPERSIDE_CHAT_MODE_VALUE

    # A blank Side Chat has no copied transcript.
    items_resp = await client.get(f"/v1/sessions/{new_id}/items")
    assert items_resp.status_code == 200, items_resp.text
    assert items_resp.json()["data"] == []


async def test_blank_title_is_optional(client: httpx.AsyncClient) -> None:
    super_chat_id = await _create_super_chat(client, "side-chats-blank-no-title")

    resp = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "blank"},
    )
    assert resp.status_code == 201, resp.text


# ── first_message ─────────────────────────────────────────────────────


async def test_first_message_failure_still_leaves_the_side_chat_created(
    client: httpx.AsyncClient,
) -> None:
    """The new Side Chat is unbound in this harness (no host wired), so
    posting ``first_message`` 503s on the runner-dispatch step and the
    route reports it — but the Side Chat itself (and its labels) were
    already committed and are not rolled back by that later failure."""
    super_chat_id = await _create_super_chat(client, "side-chats-first-message-fail")

    resp = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "blank", "title": "t", "first_message": "what's in this file?"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["first_message_error"], resp.text
    new_id = resp.json()["conversation_id"]

    get_resp = await client.get(f"/v1/sessions/{new_id}/labels")
    assert get_resp.status_code == 200, get_resp.text
    assert get_resp.json()["labels"][SIDE_CHAT_START_LABEL_KEY] == "blank"


# ── Refusals ───────────────────────────────────────────────────────────


async def test_refused_from_a_side_chat(client: httpx.AsyncClient) -> None:
    super_chat_id = await _create_super_chat(client, "side-chats-refuse-from-side-chat")
    opened = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "blank", "title": "a side chat"},
    )
    assert opened.status_code == 201, opened.text
    side_chat_id = opened.json()["conversation_id"]

    resp = await client.post(
        f"/v1/sessions/{side_chat_id}/side_chats",
        json={"start": "blank", "title": "nested"},
    )
    assert resp.status_code == 403, resp.text
    assert "Side Chat" in resp.json()["error"]["message"]


async def test_refused_from_a_sub_agent(client: httpx.AsyncClient) -> None:
    super_chat_id = await _create_super_chat(client, "side-chats-refuse-from-sub-agent")
    agent = await create_test_agent(client, name="side-chats-refuse-sub-agent-type")
    sub_agent_resp = await client.post(
        "/v1/sessions",
        json={
            "agent_id": agent["id"],
            "parent_session_id": super_chat_id,
            "labels": {CONTEXT_MODE_LABEL: SUPERSIDE_CHAT_MODE_VALUE},
        },
    )
    assert sub_agent_resp.status_code == 201, sub_agent_resp.text
    sub_agent_id = sub_agent_resp.json()["id"]

    resp = await client.post(
        f"/v1/sessions/{sub_agent_id}/side_chats",
        json={"start": "blank", "title": "nested"},
    )
    assert resp.status_code == 403, resp.text
    assert "Sub-agent" in resp.json()["error"]["message"]


async def test_refused_outside_superside_chat_mode(client: httpx.AsyncClient) -> None:
    agent = await create_test_agent(client, name="side-chats-refuse-plain")
    plain_resp = await client.post("/v1/sessions", json={"agent_id": agent["id"]})
    assert plain_resp.status_code == 201, plain_resp.text
    plain_id = plain_resp.json()["id"]

    resp = await client.post(
        f"/v1/sessions/{plain_id}/side_chats",
        json={"start": "blank", "title": "t"},
    )
    assert resp.status_code == 403, resp.text


async def test_missing_session_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/v1/sessions/conv_does_not_exist/side_chats",
        json={"start": "blank", "title": "t"},
    )
    assert resp.status_code == 404


async def test_invalid_start_is_rejected(client: httpx.AsyncClient) -> None:
    super_chat_id = await _create_super_chat(client, "side-chats-invalid-start")
    resp = await client.post(
        f"/v1/sessions/{super_chat_id}/side_chats",
        json={"start": "sideways", "title": "t"},
    )
    assert resp.status_code == 422
