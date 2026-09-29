"""Tests for the Asks routes (``GET /asks``, ``POST /asks/{id}/answer``).

Mounts only ``omnigent.nova.asks.routes`` on a bare FastAPI app (not the full
``create_app``) — these routes have no dependency on the rest of the server,
and keeping the test isolated avoids paying (or depending on) the whole
app's boot cost. Header auth (``UnifiedAuthProvider``) exercises real
multi-user ownership; a bridge stand-in swaps out the elicitation machinery,
which is covered separately in ``test_bridge.py``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from omnigent.errors import OmnigentError
from omnigent.nova._shared import NovaDeps
from omnigent.nova.asks import bridge
from omnigent.nova.asks.routes import create_router
from omnigent.server.auth import UnifiedAuthProvider

ALICE = "alice@example.com"
BOB = "bob@example.com"


def _auth_headers(user: str) -> dict[str, str]:
    return {"X-Forwarded-Email": user}


@pytest.fixture(autouse=True)
def _stub_bridge(monkeypatch: pytest.MonkeyPatch) -> None:
    """Answering an Ask always tries to reach the bridge; make that a no-op here."""

    async def noop(ask: object, answer_text: str) -> None:
        del ask, answer_text

    monkeypatch.setattr(bridge, "on_answered", noop)


@pytest.fixture()
def app(db_uri: str) -> FastAPI:
    auth_provider = UnifiedAuthProvider(
        source="header",
        local_single_user=False,
        header_name="X-Forwarded-Email",
        header_strip_prefix="",
    )
    deps = NovaDeps(storage_location=db_uri, auth_provider=auth_provider, conversation_store=None)
    fastapi_app = FastAPI()
    fastapi_app.include_router(create_router(deps), prefix="/v1/nova")

    @fastapi_app.exception_handler(OmnigentError)
    async def _handle_error(request: object, exc: OmnigentError) -> JSONResponse:
        del request
        return JSONResponse(status_code=exc.http_status, content={"code": str(exc.code)})

    return fastapi_app


@pytest_asyncio.fixture()
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# Asks has no "create" route of its own (that's tools.py / the bridge);
# every test below seeds an Ask directly through an AskService built against
# the same ``db_uri`` the app's router uses.

# ── list ─────────────────────────────────────────────────────────────────


async def test_list_open_requires_auth(client: httpx.AsyncClient) -> None:
    response = await client.get("/v1/nova/asks")
    assert response.status_code == 401


async def test_list_open_returns_only_the_callers_asks(
    client: httpx.AsyncClient, db_uri: str
) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.asks.entities import AskKind
    from omnigent.nova.asks.service import AskService
    from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

    service = AskService(SqlAlchemyAskStore(db_uri))
    service.open_ask(actor=NovaActor(user_id=ALICE), kind=AskKind.QUESTION, text="For Alice")
    service.open_ask(actor=NovaActor(user_id=BOB), kind=AskKind.QUESTION, text="For Bob")

    response = await client.get("/v1/nova/asks", headers=_auth_headers(ALICE))
    assert response.status_code == 200
    data = response.json()["data"]
    assert [a["text"] for a in data] == ["For Alice"]


# ── answer ───────────────────────────────────────────────────────────────


async def test_answer_requires_auth(client: httpx.AsyncClient) -> None:
    response = await client.post("/v1/nova/asks/whatever/answer", json={"answer": "yes"})
    assert response.status_code == 401


async def test_answer_unknown_ask_is_404(client: httpx.AsyncClient) -> None:
    from omnigent.nova._shared import new_id

    response = await client.post(
        f"/v1/nova/asks/{new_id()}/answer",
        json={"answer": "yes"},
        headers=_auth_headers(ALICE),
    )
    assert response.status_code == 404


async def test_answer_someone_elses_ask_is_404(client: httpx.AsyncClient, db_uri: str) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.asks.entities import AskKind
    from omnigent.nova.asks.service import AskService
    from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

    service = AskService(SqlAlchemyAskStore(db_uri))
    ask = service.open_ask(actor=NovaActor(user_id=ALICE), kind=AskKind.QUESTION, text="Private")

    response = await client.post(
        f"/v1/nova/asks/{ask.id}/answer", json={"answer": "yes"}, headers=_auth_headers(BOB)
    )
    assert response.status_code == 404


async def test_answer_owned_ask_succeeds_and_closes_it(
    client: httpx.AsyncClient, db_uri: str
) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.asks.entities import AskKind
    from omnigent.nova.asks.service import AskService
    from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

    service = AskService(SqlAlchemyAskStore(db_uri))
    ask = service.open_ask(actor=NovaActor(user_id=ALICE), kind=AskKind.QUESTION, text="Ship it?")

    response = await client.post(
        f"/v1/nova/asks/{ask.id}/answer", json={"answer": "yes"}, headers=_auth_headers(ALICE)
    )
    assert response.status_code == 200
    assert response.json()["status"] == "answered"
    assert response.json()["answer"] == "yes"

    listing = await client.get("/v1/nova/asks", headers=_auth_headers(ALICE))
    assert listing.json()["data"] == []


async def test_answer_rejects_option_not_offered(client: httpx.AsyncClient, db_uri: str) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.asks.entities import AskAction, AskKind
    from omnigent.nova.asks.service import AskService
    from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

    service = AskService(SqlAlchemyAskStore(db_uri))
    actions = (AskAction(id="yes", label="Yes"), AskAction(id="no", label="No"))
    ask = service.open_ask(
        actor=NovaActor(user_id=ALICE), kind=AskKind.APPROVAL, text="Deploy?", actions=actions
    )

    response = await client.post(
        f"/v1/nova/asks/{ask.id}/answer", json={"answer": "maybe"}, headers=_auth_headers(ALICE)
    )
    assert response.status_code == 400


async def test_answer_already_answered_is_409(client: httpx.AsyncClient, db_uri: str) -> None:
    from omnigent.nova._shared import NovaActor
    from omnigent.nova.asks.entities import AskKind
    from omnigent.nova.asks.service import AskService
    from omnigent.nova.asks.sqlalchemy_store import SqlAlchemyAskStore

    service = AskService(SqlAlchemyAskStore(db_uri))
    ask = service.open_ask(actor=NovaActor(user_id=ALICE), kind=AskKind.QUESTION, text="Ship it?")
    service.answer(NovaActor(user_id=ALICE), ask.id, "yes")

    response = await client.post(
        f"/v1/nova/asks/{ask.id}/answer", json={"answer": "no"}, headers=_auth_headers(ALICE)
    )
    assert response.status_code == 409
