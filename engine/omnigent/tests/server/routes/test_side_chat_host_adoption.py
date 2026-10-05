"""A Side Chat adopts its parent's host and wakes it once before dispatch."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from omnigent.server.routes._sessions import orchestration
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY, SIDE_CHAT_PARENT_LABEL_KEY

_SIDE_LABELS = {SIDE_CHAT_LABEL_KEY: "1", SIDE_CHAT_PARENT_LABEL_KEY: "conv_parent"}


class _Store:
    def __init__(self, rows: dict[str, Any]) -> None:
        self.rows = rows
        self.bound: list[tuple[str, str, str | None]] = []

    def get_conversation(self, conv_id: str) -> Any:
        return self.rows.get(conv_id)

    def set_host_id(self, conv_id: str, host_id: str, workspace: str | None = None) -> Any:
        self.bound.append((conv_id, host_id, workspace))
        row = self.rows[conv_id]
        row.host_id, row.workspace = host_id, workspace
        return row


def _row(**kw: Any) -> Any:
    base = {"labels": {}, "host_id": None, "workspace": None}
    return SimpleNamespace(**{**base, **kw})


def _state(online: bool) -> Any:
    registry = SimpleNamespace(get=lambda host_id: object() if online else None)
    return SimpleNamespace(host_registry=registry)


@pytest.fixture
def relaunches(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    async def fake_relaunch(*, session_id: str, **_: Any) -> bool:
        calls.append(session_id)
        return True

    async def no_runner(*_: Any, **__: Any) -> None:
        return None

    monkeypatch.setattr(orchestration, "_maybe_relaunch_managed_sandbox", fake_relaunch)
    monkeypatch.setattr(orchestration, "_get_runner_client", no_runner)
    return calls


async def _adopt(store: _Store, online: bool) -> Any:
    return await orchestration._adopt_parent_host_for_side_chat(
        session_id="conv_side",
        conv=store.rows["conv_side"],
        app_state=_state(online),
        conversation_store=store,  # type: ignore[arg-type]
        runner_router=None,
    )


@pytest.mark.asyncio
async def test_unbound_side_chat_binds_parent_host_and_wakes_offline_host(relaunches):
    store = _Store(
        {
            "conv_side": _row(labels=_SIDE_LABELS),
            "conv_parent": _row(host_id="host_1", workspace="/ws"),
        }
    )
    conv = await _adopt(store, online=False)
    assert relaunches == ["conv_parent"]
    assert store.bound == [("conv_side", "host_1", "/ws")]
    assert conv.host_id == "host_1"


@pytest.mark.asyncio
async def test_online_parent_host_is_bound_without_relaunch(relaunches):
    store = _Store(
        {
            "conv_side": _row(labels=_SIDE_LABELS),
            "conv_parent": _row(host_id="host_1", workspace="/ws"),
        }
    )
    await _adopt(store, online=True)
    assert relaunches == []
    assert store.bound == [("conv_side", "host_1", "/ws")]


@pytest.mark.asyncio
async def test_already_bound_side_chat_wakes_through_parent_only(relaunches):
    store = _Store(
        {
            "conv_side": _row(labels=_SIDE_LABELS, host_id="host_1", workspace="/ws"),
            "conv_parent": _row(host_id="host_1", workspace="/ws"),
        }
    )
    await _adopt(store, online=False)
    assert relaunches == ["conv_parent"]
    assert store.bound == []


@pytest.mark.asyncio
async def test_non_side_chat_is_untouched(relaunches):
    store = _Store({"conv_side": _row(), "conv_parent": _row(host_id="host_1", workspace="/ws")})
    await _adopt(store, online=False)
    assert relaunches == [] and store.bound == []
