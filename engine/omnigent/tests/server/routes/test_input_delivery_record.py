"""The server keeps how each message sent to a session was taken, and says so when it decides it.

The runner reports ``session.input.delivery`` and the relay stores it before relaying; for a
message the runner never received (its deferred dispatch failed), the server itself stores and
publishes ``cancelled``, so whoever waits on that message is never left waiting.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from omnigent.server.routes._sessions import helpers


@pytest.mark.asyncio
async def test_a_delivery_is_stored_and_published_only_when_asked() -> None:
    store = MagicMock()
    with patch.object(helpers.session_stream, "publish") as publish:
        await helpers._record_input_delivery("conv", "item", "steer", store)
        publish.assert_not_called()
        await helpers._record_input_delivery("conv", "item2", "cancelled", store, publish=True)

    assert [c.args for c in store.set_item_delivery.call_args_list] == [
        ("conv", "item", "steer"),
        ("conv", "item2", "cancelled"),
    ]
    event = publish.call_args.args[1]
    assert event["type"] == "session.input.delivery"
    assert event["data"] == {"item_id": "item2", "delivered": "cancelled"}


@pytest.mark.asyncio
@pytest.mark.parametrize(("item_id", "delivered"), [(None, "steer"), ("", "turn"), ("i", "nope")])
async def test_a_malformed_delivery_is_ignored(item_id: object, delivered: object) -> None:
    store = MagicMock()
    await helpers._record_input_delivery("conv", item_id, delivered, store, publish=True)
    store.set_item_delivery.assert_not_called()
