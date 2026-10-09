"""``PATCH /v1/artifacts/{id}/edit``, the write-back note for a hand-edited deck, stale saves."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.errors import OmnigentError
from omnigent.stores.artifact_store.local import LocalArtifactStore
from omnigent.superchat import prompt_prefix
from omnigent.superchat.artifact_kinds import KIND_MIME
from omnigent.superchat.artifacts.routes import create_artifacts_router
from omnigent.superchat.artifacts.store import SqlAlchemyArtifactStore
from omnigent.superchat.artifacts.writeback import deliver_manual_edits
from omnigent.superchat.decks.edit_routes import create_deck_edit_router

_SESSION = uuid.uuid4().hex
H = {"x-user": "alice"}
DECK = (
    '<html><body><section class="slide active" data-screen-label="01 A" data-nova-id="s1">\n'
    '<h1 data-nova-id="title" style="font-size: 64px">A</h1>\n</section></body></html>'
)


class _Auth:
    def get_user_id(self, request: Request) -> str | None:
        return request.headers.get("x-user")


@pytest.fixture()
def env(db_uri: str, tmp_path: Path):
    blobs = LocalArtifactStore(str(tmp_path / "blobs"))
    store = SqlAlchemyArtifactStore(db_uri, lambda: blobs)
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _h(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"error": exc.message}, status_code=exc.http_status)

    class _Convs:
        pass

    app.include_router(
        create_artifacts_router(store, conversation_store=_Convs(), auth_provider=_Auth()),  # type: ignore[arg-type]
        prefix="/v1",
    )
    app.include_router(create_deck_edit_router(store, auth_provider=_Auth()), prefix="/v1")
    return store, TestClient(app)


def _save(store, name="q3.deck.html", data: bytes = DECK.encode(), **kw):
    kind = name.rsplit(".", 1)[1]
    return store.create(
        user_id="alice", parent_session_id=_SESSION, name=name, title=None, kind=kind,
        mime=KIND_MIME[kind], data=data, **kw,
    )  # fmt: skip


def _edit(client, item_id, base=1, patches=None, user="alice"):
    patches = patches or [{"kind": "set-text", "id": "title", "text": "B"}]
    return client.patch(
        f"/v1/artifacts/{item_id}/edit",
        json={"base_version": base, "patches": patches},
        headers={"x-user": user},
    )


def test_edit_saves_a_manual_version(env) -> None:
    store, client = env
    v1 = _save(store, source_path="/ws/q3.deck.html")
    resp = _edit(client, v1.id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["version"] == 2 and body["origin"] == "manual"
    assert body["parent_version_id"] == v1.id
    assert body["edit_summary"] == 'slide 1 title "A" → "B"'
    new = store.get(body["id"], user_id="alice")
    assert new.source_path == "/ws/q3.deck.html"
    assert store.read(new) == DECK.replace(">A<", ">B<").encode()
    assert store.read(v1) == DECK.encode()  # the old version is untouched


def test_stale_base_is_a_409(env) -> None:
    store, client = env
    v1 = _save(store)
    assert _edit(client, v1.id).status_code == 200
    stale = _edit(client, v1.id, base=1)
    assert stale.status_code == 409 and "Stale edit" in stale.json()["error"]


def test_ambiguous_patch_is_a_409_ask_nova(env) -> None:
    store, client = env
    v1 = _save(store)
    resp = _edit(client, v1.id, patches=[{"kind": "remove-element", "id": "missing"}])
    assert resp.status_code == 409 and resp.json()["error"].endswith("ask Nova instead.")
    assert len(store.versions(v1)) == 1


def test_bad_patch_is_a_400_and_non_deck_is_refused(env) -> None:
    store, client = env
    v1 = _save(store)
    bad = _edit(
        client, v1.id, patches=[{"kind": "set-style", "id": "title", "style": {"color": "url(x)"}}]
    )
    assert bad.status_code == 400
    page = _save(store, name="page.html")
    assert _edit(client, page.id).status_code == 400
    assert _edit(client, v1.id, patches=[{"kind": "nope"}]).status_code == 422


def test_other_owners_edit_is_not_found(env) -> None:
    store, client = env
    v1 = _save(store)
    assert _edit(client, v1.id, user="mallory").status_code == 404


def test_undo_as_full_source_is_a_new_version(env) -> None:
    store, client = env
    v1 = _save(store)
    v2 = _edit(client, v1.id).json()
    undo = _edit(client, v2["id"], base=2, patches=[{"kind": "set-full-source", "source": DECK}])
    assert undo.status_code == 200 and undo.json()["version"] == 3
    assert store.read(store.get(undo.json()["id"], user_id="alice")) == DECK.encode()


# ------------------------------------------------------------ write-back + note + stale save


class _FakeServer:
    def __init__(self, client: TestClient) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            r = client.request(
                request.method, request.url.raw_path.decode(),
                headers=H, content=request.content,
            )  # fmt: skip
            return httpx.Response(r.status_code, content=r.content, headers=r.headers)

        self.client = httpx.AsyncClient(
            transport=httpx.MockTransport(handler), base_url="http://server"
        )


def test_deck_edit_is_written_back_and_noted_once(env, tmp_path: Path) -> None:
    store, client = env
    target = tmp_path / "q3.deck.html"
    target.write_bytes(DECK.encode())
    v1 = _save(store, source_path=str(target))
    patches = [
        {"kind": "set-text", "id": "title", "text": "B"},
        {"kind": "set-style", "id": "title", "style": {"font-size": "72px"}},
    ]
    assert _edit(client, v1.id, patches=patches).status_code == 200
    server = _FakeServer(client).client
    notes = asyncio.run(deliver_manual_edits(server, _SESSION, roots=[tmp_path.resolve()]))
    expected = DECK.replace(">A<", ">B<").replace("font-size: 64px", "font-size: 72px;")
    assert target.read_bytes() == expected.encode()
    assert notes == [
        "The person edited q3.deck.html by hand (v1 → v2): "
        'slide 1 title "A" → "B"; slide 1 title font-size 64px→72px. Treat v2 as current.'
    ]
    assert asyncio.run(deliver_manual_edits(server, _SESSION, roots=[tmp_path.resolve()])) == []


def test_turn_prefix_carries_deck_note(env, tmp_path: Path, monkeypatch) -> None:
    store, client = env
    target = tmp_path / "q3.deck.html"
    target.write_bytes(DECK.encode())
    _edit(client, _save(store, source_path=str(target)).id)
    import omnigent.superchat.artifacts.writeback as wb

    monkeypatch.setattr(wb, "workspace_roots", lambda: [tmp_path.resolve()])
    blocks = asyncio.run(
        prompt_prefix.turn_prefix_blocks(_FakeServer(client).client, _SESSION, None)
    )
    assert any("edited q3.deck.html by hand (v1 → v2)" in b for b in blocks)


def test_muse_save_over_an_unseen_hand_edit_is_refused(env, tmp_path: Path) -> None:
    store, client = env
    v1 = _save(store)
    _edit(client, v1.id)
    url = f"/v1/artifacts?parent_session_id={_SESSION}&name=q3.deck.html"
    resp = client.post(url, content=DECK.encode(), headers=H)
    assert resp.status_code == 409
    assert "edited q3.deck.html by hand (v2)" in resp.json()["error"]
    assert len(store.versions(v1)) == 2
    # Once the Muse was told (delivered), a save on top is fine.
    (pending,) = store.pending_manual(user_id="alice", parent_session_id=_SESSION)
    store.mark_delivered(pending.id, user_id="alice")
    assert client.post(url, content=DECK.encode(), headers=H).status_code == 201
