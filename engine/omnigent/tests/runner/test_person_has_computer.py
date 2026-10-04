"""Tests for the runner's "person is in control of the computer" gate."""

from __future__ import annotations

import httpx
import pytest

from omnigent.runner.tool_dispatch import _person_has_computer

pytestmark = pytest.mark.asyncio


def _client(status: int, body: object) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/sessions/conv_1/computer"
        return httpx.Response(status, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://s")


async def test_true_only_when_server_reports_in_control() -> None:
    assert await _person_has_computer(
        _client(200, {"available": True, "in_control": True}), "conv_1"
    )
    assert not await _person_has_computer(
        _client(200, {"available": True, "in_control": False}), "conv_1"
    )


async def test_fails_open_on_errors_and_missing_inputs() -> None:
    assert not await _person_has_computer(_client(500, {}), "conv_1")
    assert not await _person_has_computer(None, "conv_1")
    assert not await _person_has_computer(_client(200, {"in_control": True}), None)
