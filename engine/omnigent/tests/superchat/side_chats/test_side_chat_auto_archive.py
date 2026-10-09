"""Per-person Side Chat auto-archive: the ``/v1/me/archiving`` setting and the sweep."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from omnigent.errors import OmnigentError
from omnigent.stores.conversation_store import SIDE_CHAT_LABEL_KEY
from omnigent.stores.conversation_store.sqlalchemy_store import SqlAlchemyConversationStore
from omnigent.superchat.muse import MUSE_KEY_LABEL_KEY, MUSE_LABEL_KEY, muse_key
from omnigent.superchat.side_chats.archiving import (
    PREFERENCE_KEY,
    SWEEP_INTERVAL_SECONDS_ENV,
    ArchivePrefsStore,
    SideChatArchiveSweeper,
    register_archiving_routes,
    resolve_sweep_interval_seconds,
    validate_setting,
)

_MODE = {"omnigent.context.mode": "superside-chat"}
DAY = 24 * 3600
NOW = 100 * DAY


@pytest.fixture()
def prefs(db_uri: str) -> ArchivePrefsStore:
    return ArchivePrefsStore(db_uri)


@pytest.fixture()
async def client(prefs: ArchivePrefsStore) -> httpx.AsyncClient:
    app = FastAPI()

    @app.exception_handler(OmnigentError)
    async def _handler(_request, exc: OmnigentError):  # type: ignore[no-untyped-def]
        from fastapi.responses import JSONResponse

        return JSONResponse({"code": str(exc.code)}, status_code=400)

    app.include_router(register_archiving_routes(prefs), prefix="/v1")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as http:
        yield http


async def test_unset_shows_the_deployment_default_and_every_state_round_trips(
    client: httpx.AsyncClient,
) -> None:
    assert (await client.get("/v1/me/archiving")).json() == {
        PREFERENCE_KEY: 30,
        "default_days": 30,
    }
    for put, effective in [(7, 7), (1, 1), (None, None), (30, 30), ("default", 30)]:
        resp = await client.put("/v1/me/archiving", json={PREFERENCE_KEY: put})
        assert resp.json() == {PREFERENCE_KEY: effective, "default_days": 30}
        assert (await client.get("/v1/me/archiving")).json() == resp.json()


async def test_never_is_explicit_and_default_restores_it(
    client: httpx.AsyncClient, prefs: ArchivePrefsStore
) -> None:
    from omnigent.superchat.muse import muse_key

    key = muse_key("local", None)
    await client.put("/v1/me/archiving", json={PREFERENCE_KEY: None})
    assert prefs.get(key) is None
    await client.put("/v1/me/archiving", json={PREFERENCE_KEY: "default"})
    assert prefs.get(key) == "default"


async def test_deployment_default_is_configurable(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OMNIGENT_SIDE_CHAT_ARCHIVE_AFTER_SECONDS", str(7 * DAY))
    assert (await client.get("/v1/me/archiving")).json() == {PREFERENCE_KEY: 7, "default_days": 7}


@pytest.mark.parametrize("bad", [0, 2, 365, -1, "7", "never", True, 7.5])
async def test_invalid_values_are_refused_with_a_stable_code(
    client: httpx.AsyncClient, bad: object
) -> None:
    resp = await client.put("/v1/me/archiving", json={PREFERENCE_KEY: bad})
    assert resp.status_code == 400
    assert resp.json()["code"] == "invalid_input"
    assert (await client.get("/v1/me/archiving")).json()[PREFERENCE_KEY] == 30


async def test_missing_field_is_refused(client: httpx.AsyncClient) -> None:
    resp = await client.put("/v1/me/archiving", json={})
    assert resp.json()["code"] == "invalid_input"


def test_validate_setting() -> None:
    assert validate_setting(None) is None
    assert validate_setting("default") == "default"
    assert validate_setting(7) == 7
    with pytest.raises(OmnigentError):
        validate_setting(3)


def test_interval_defaults_to_hourly_and_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SWEEP_INTERVAL_SECONDS_ENV, raising=False)
    assert resolve_sweep_interval_seconds() == 3600.0
    monkeypatch.setenv(SWEEP_INTERVAL_SECONDS_ENV, "60")
    assert resolve_sweep_interval_seconds() == 60.0
    for bad in ("nope", "0", "-1"):
        monkeypatch.setenv(SWEEP_INTERVAL_SECONDS_ENV, bad)
        assert resolve_sweep_interval_seconds() == 3600.0


def _person(store: SqlAlchemyConversationStore, user: str) -> tuple[str, str]:
    """A Muse; returns ``(muse_id, key)``."""
    key = muse_key(user, None)
    muse = store.create_conversation(
        kind="default",
        title="Muse",
        labels={**_MODE, MUSE_LABEL_KEY: "true", MUSE_KEY_LABEL_KEY: key},
    )
    return muse.id, key


def _side(store: SqlAlchemyConversationStore, muse_id: str, **extra: str) -> str:
    chat = store.create_conversation(
        kind="default",
        title="Side",
        labels={
            **_MODE,
            SIDE_CHAT_LABEL_KEY: "true",
            "omnigent.side_chat.parent_id": muse_id,
            **extra,
        },
    )
    return chat.id


def _age(store: SqlAlchemyConversationStore, ids: list[str], updated_at: int) -> None:
    from sqlalchemy import update

    from omnigent.db.db_models import SqlConversation

    with store._session("test_age") as session:
        for conv_id in ids:
            session.execute(
                update(SqlConversation)
                .where(SqlConversation.id == conv_id)
                .values(updated_at=updated_at)
            )


def _sweeper(prefs, store, archived: list[str]) -> SideChatArchiveSweeper:
    async def archive(session_id: str) -> None:
        store.update_conversation(session_id, archived=True)
        archived.append(session_id)

    return SideChatArchiveSweeper(prefs, store, archive)


async def test_everyone_is_swept_by_their_effective_age(
    prefs: ArchivePrefsStore, conversation_store: SqlAlchemyConversationStore
) -> None:
    store = conversation_store
    ann, _ = _person(store, "ann")  # unset: the 30 day default
    bob, bob_key = _person(store, "bob")  # explicit never
    cat, cat_key = _person(store, "cat")  # a week
    prefs.set(bob_key, None)
    prefs.set(cat_key, 7)
    ann_old, ann_mid = _side(store, ann), _side(store, ann)
    bob_old = _side(store, bob)
    cat_old, cat_fresh = _side(store, cat), _side(store, cat)
    _age(store, [ann_old, bob_old], NOW - 31 * DAY)
    _age(store, [ann_mid, cat_old], NOW - 8 * DAY)
    _age(store, [cat_fresh], NOW - 2 * DAY)

    got: list[str] = []
    assert await _sweeper(prefs, store, got).sweep_once(NOW) == 2
    assert sorted(got) == sorted([ann_old, cat_old])
    for untouched in (ann_mid, bob_old, cat_fresh, ann, bob, cat):
        assert not store.get_conversation(untouched).archived
    # Idempotent.
    assert await _sweeper(prefs, store, got).sweep_once(NOW) == 0


async def test_only_idle_side_chats_qualify(
    prefs: ArchivePrefsStore, conversation_store: SqlAlchemyConversationStore
) -> None:
    from omnigent.stores.conversation_store import FORK_SOURCE_LABEL_KEY

    store = conversation_store
    muse, key = _person(store, "ann")
    prefs.set(key, 7)
    old = _side(store, muse)
    live, waiting, done = _side(store, muse), _side(store, muse), _side(store, muse)
    # Legacy fork: only the fork-source label links it, and nobody was ever granted it.
    legacy = store.create_conversation(
        kind="default",
        title="Fork",
        labels={**_MODE, SIDE_CHAT_LABEL_KEY: "true", FORK_SOURCE_LABEL_KEY: muse},
    ).id
    helper = store.create_conversation(
        kind="sub_agent",
        title="Helper",
        labels={**_MODE, "omnigent.subagent": "x", "omnigent.side_chat.parent_id": muse},
    ).id
    store.update_conversation(done, archived=True)
    store.set_session_live_status(live, "running")
    store.set_session_live_status(waiting, "waiting")
    _age(store, [muse, old, live, waiting, done, legacy, helper], NOW - 8 * DAY)

    got: list[str] = []
    assert await _sweeper(prefs, store, got).sweep_once(NOW) == 2
    assert sorted(got) == sorted([old, legacy])
    for untouched in (live, waiting, muse, helper):
        assert not store.get_conversation(untouched).archived


async def test_the_deployment_default_applies_to_people_who_never_chose(
    prefs: ArchivePrefsStore,
    conversation_store: SqlAlchemyConversationStore,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMNIGENT_SIDE_CHAT_ARCHIVE_AFTER_SECONDS", "3600")
    muse, _key = _person(conversation_store, "ann")
    side = _side(conversation_store, muse)
    _age(conversation_store, [side], NOW - 7200)
    got: list[str] = []
    assert await _sweeper(prefs, conversation_store, got).sweep_once(NOW) == 1
    assert got == [side]


async def test_a_server_without_a_preferences_store_still_applies_the_default(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    muse, _key = _person(conversation_store, "ann")
    side = _side(conversation_store, muse)
    _age(conversation_store, [side], NOW - 31 * DAY)
    got: list[str] = []
    assert await _sweeper(None, conversation_store, got).sweep_once(NOW) == 1


async def test_feature_registration_mounts_the_route_and_the_one_job(
    db_uri: str, conversation_store: SqlAlchemyConversationStore
) -> None:
    """``FEATURE.install`` / ``FEATURE.jobs`` as the server calls them, end to end."""
    from types import SimpleNamespace

    from omnigent.superchat.feature import InstallDeps
    from omnigent.superchat.features import FEATURES
    from omnigent.superchat.side_chats import FEATURE

    assert FEATURE in FEATURES
    app = FastAPI()
    FEATURE.install(
        app,
        InstallDeps(
            scheduled_task_store=SimpleNamespace(storage_location=db_uri),
            conversation_store=conversation_store,
            agent_store=None,
            permission_store=None,
            auth_provider=None,
        ),
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://t"
    ) as http:
        assert (await http.get("/v1/me/archiving")).json() == {
            PREFERENCE_KEY: 30,
            "default_days": 30,
        }
        assert (await http.put("/v1/me/archiving", json={PREFERENCE_KEY: 1})).status_code == 200

    jobs = FEATURE.jobs(app)
    assert len(jobs) == 1
    assert isinstance(jobs[0], SideChatArchiveSweeper)

    # The registered job archives through the manual path.
    muse, _ = _person(conversation_store, "local")
    side = _side(conversation_store, muse)
    _age(conversation_store, [side], NOW - 2 * DAY)
    from omnigent.server.routes._sessions.orchestration import _cancel_pending_archive_stop

    try:
        # The route above stored "1 day" for the auth-less local user's Muse key.
        assert await jobs[0].sweep_once(NOW) == 1
        assert conversation_store.get_conversation(side).archived
    finally:
        _cancel_pending_archive_stop(side)


async def test_archive_path_is_the_manual_one(
    conversation_store: SqlAlchemyConversationStore,
) -> None:
    """Archived flag, family ``chats.changed`` signal and the deferred runner stop."""
    import asyncio
    from types import SimpleNamespace

    from omnigent.server.routes._sessions.orchestration import (
        _cancel_pending_archive_stop,
        _pending_archive_stops,
    )
    from omnigent.superchat.family.signals import listen_chats_changed
    from omnigent.superchat.side_chats.archiving import manual_archive_steps

    muse, _key = _person(conversation_store, "ann")
    side = _side(conversation_store, muse)
    queue: asyncio.Queue[dict] = asyncio.Queue()
    stop = listen_chats_changed(muse, queue)
    try:
        app = SimpleNamespace(state=SimpleNamespace())
        await manual_archive_steps(app, conversation_store)(side)
        assert conversation_store.get_conversation(side).archived
        assert (await asyncio.wait_for(queue.get(), 1)) == {
            "type": "chats.changed",
            "root_id": muse,
        }
        assert side in _pending_archive_stops
    finally:
        stop()
        _cancel_pending_archive_stop(side)
