"""Selection: the caller's catalog per harness, personal defaults, and how a session picks."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from omnigent.db.db_models import OmnigentBase
from omnigent.db.utils import get_or_create_engine
from omnigent.errors import OmnigentError
from omnigent.inference_config import HarnessInferenceBinding
from omnigent.onboarding.provider_config import ProviderEntry
from omnigent.server.inference_catalog import SandboxInferenceService
from omnigent.server.routes.sandbox_inference import (
    prepare_create_inference,
    snapshot_serves_model,
)
from omnigent.superchat.models.selection import (
    ModelPreferenceStore,
    create_model_selection_router,
)

from .test_byok_pi import _hosted_state
from .test_inference_catalog import _state  # noqa: F401


@pytest.fixture
def app(tmp_path: Path) -> FastAPI:
    uri = f"sqlite:///{tmp_path / 's.db'}"
    OmnigentBase.metadata.create_all(get_or_create_engine(uri))
    state = _hosted_state({})

    class _Store:
        def get_plaintext(self, scope, owner_id, preferred):
            return ("anthropic", "sk-ant-x") if scope == "user" else None

    state.model_connection_store = _Store()
    state.model_preference_store = ModelPreferenceStore(uri)
    application = FastAPI()
    for name, value in vars(state).items():
        setattr(application.state, name, value)
    application.include_router(
        create_model_selection_router(application.state.model_preference_store), prefix="/v1"
    )

    @application.exception_handler(OmnigentError)
    async def _err(_: Request, exc: OmnigentError) -> JSONResponse:
        return JSONResponse({"code": str(exc.code)}, status_code=exc.http_status)

    return application


def _models(client: TestClient, harness: str) -> dict:
    return client.get("/v1/me/models", params={"harness": harness}).json()


def test_models_are_filtered_per_harness_and_flagged(app: FastAPI) -> None:
    client = TestClient(app)
    sdk = _models(client, "claude-sdk")
    assert sdk["status"] == "ready"
    assert [m["id"] for m in sdk["models"]] == ["claude-sonnet-5-5", "claude-haiku-4-5"]
    sonnet = sdk["models"][0]
    assert sonnet["is_default"] is True and sonnet["is_user_default"] is False
    assert sonnet["family"] == "claude" and sonnet["wire_api"] == "anthropic-messages"
    # pi on an Anthropic key: the key's own list, nothing named in configuration.
    pi = {m["id"]: m for m in _models(client, "pi")["models"]}
    assert list(pi) == ["claude-sonnet-5-5", "claude-haiku-4-5"]


def test_preferences_round_trip_and_flag(app: FastAPI) -> None:
    client = TestClient(app)
    empty = {"defaults": {}, "light": {}}
    assert client.get("/v1/me/model-preferences").json() == empty
    put = client.put(
        "/v1/me/model-preferences", json={"defaults": {"claude-sdk": "claude-haiku-4-5"}}
    )
    assert put.json() == {"defaults": {"claude-sdk": "claude-haiku-4-5"}, "light": {}}
    assert client.get("/v1/me/model-preferences").json() == put.json()
    flagged = {m["id"]: m["is_user_default"] for m in _models(client, "claude-sdk")["models"]}
    assert flagged == {"claude-sonnet-5-5": False, "claude-haiku-4-5": True}
    client.put("/v1/me/model-preferences", json={"defaults": {}})
    assert client.get("/v1/me/model-preferences").json() == empty


def test_light_is_automatic_until_picked_and_kept_apart_from_the_default(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.superchat.models import tiers

    prices = {"claude-sonnet-5-5": (3e-6, 15e-6), "claude-haiku-4-5": (1e-6, 5e-6)}
    monkeypatch.setattr(tiers, "catalog_price", prices.get)
    client = TestClient(app)
    sdk = _models(client, "claude-sdk")
    assert sdk["light_pick"] is None
    assert sdk["light_model"] == sdk["automatic_light_model"] == "claude-haiku-4-5"
    assert {m["id"]: m["is_light"] for m in sdk["models"]} == {
        "claude-sonnet-5-5": False,
        "claude-haiku-4-5": True,
    }
    # The person picks Light; their Default is left alone, and vice versa.
    client.put("/v1/me/model-preferences", json={"defaults": {"claude-sdk": "claude-haiku-4-5"}})
    put = client.put(
        "/v1/me/model-preferences", json={"light": {"claude-sdk": "claude-sonnet-5-5"}}
    )
    assert put.json() == {
        "defaults": {"claude-sdk": "claude-haiku-4-5"},
        "light": {"claude-sdk": "claude-sonnet-5-5"},
    }
    sdk = _models(client, "claude-sdk")
    assert sdk["light_pick"] == sdk["light_model"] == "claude-sonnet-5-5"
    assert sdk["automatic_light_model"] == "claude-haiku-4-5"
    client.put("/v1/me/model-preferences", json={"defaults": {}})
    assert client.get("/v1/me/model-preferences").json()["light"] == {
        "claude-sdk": "claude-sonnet-5-5"
    }
    # Back to Automatic.
    client.put("/v1/me/model-preferences", json={"light": {}})
    assert _models(client, "claude-sdk")["light_pick"] is None
    bad = client.put("/v1/me/model-preferences", json={"light": {"claude-sdk": "gpt-5-4"}})
    assert bad.status_code == 400 and bad.json() == {"code": "model_not_supported"}


def test_a_row_written_before_light_reads_as_defaults(app: FastAPI) -> None:
    import json

    from omnigent.db.db_models import SqlPreference

    store = app.state.model_preference_store
    store.set("local", {"claude-sdk": "claude-haiku-4-5"})
    with store._session_immediate("legacy") as session:
        row = session.query(SqlPreference).one()
        row.value = json.dumps({"claude-sdk": "claude-haiku-4-5"})
    picks = store.read("local")
    assert picks.defaults == {"claude-sdk": "claude-haiku-4-5"} and picks.light == {}


def test_preferences_reject_models_the_connection_does_not_serve(app: FastAPI) -> None:
    client = TestClient(app)
    bad = client.put("/v1/me/model-preferences", json={"defaults": {"claude-sdk": "gpt-5-4"}})
    assert bad.status_code == 400 and bad.json() == {"code": "model_not_supported"}
    nope = client.put("/v1/me/model-preferences", json={"defaults": {"nope": "x"}})
    assert nope.status_code == 400 and nope.json() == {"code": "invalid_input"}
    assert client.get("/v1/me/model-preferences").json() == {"defaults": {}, "light": {}}


def _create(app: FastAPI, **kwargs):
    store = kwargs.pop("conversation_store", None)
    body = SimpleNamespace(
        host_type="managed",
        sandbox_provider=None,
        parent_session_id=kwargs.pop("parent", None),
        inference_configuration_revision=None,
        cost_control_mode_override=None,
    )
    spec = SimpleNamespace(
        executor=SimpleNamespace(type="claude-sdk", config={}, auth=None, profile=None)
    )
    request = SimpleNamespace(app=app)
    return prepare_create_inference(request, body, spec, None, store, **kwargs)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_session_picks_override_then_user_default_then_binding_default(app: FastAPI) -> None:
    assert (await _create(app))[1] == "claude-sonnet-5-5"
    app.state.model_preference_store.set("local", {"claude-sdk": "claude-haiku-4-5"})
    assert (await _create(app))[1] == "claude-haiku-4-5"
    assert (await _create(app, model_override="claude-sonnet-5-5"))[1] == "claude-sonnet-5-5"
    # A default the catalog no longer serves is ignored, not an error.
    app.state.model_preference_store.set("local", {"claude-sdk": "claude-gone"})
    assert (await _create(app))[1] == "claude-sonnet-5-5"


@pytest.mark.asyncio
async def test_sub_agent_pin_outside_the_catalog_inherits_the_parent(app: FastAPI) -> None:
    snapshot, _ = await _create(app)
    parent = SimpleNamespace(inference_snapshot=snapshot, model_override="claude-haiku-4-5")
    store = SimpleNamespace(get_conversation=lambda _id: parent)
    app.state.model_preference_store.set("local", {"claude-sdk": "claude-sonnet-5-5"})
    kwargs = {"parent": "p1", "conversation_store": store}
    assert (await _create(app, model_override="gpt-5-4", **kwargs))[1] == "claude-haiku-4-5"
    assert (await _create(app, model_override="claude-sonnet-5-5", **kwargs))[1] == (
        "claude-sonnet-5-5"
    )
    # No pin: the parent's model, not the person's default.
    assert (await _create(app, **kwargs))[1] == "claude-sonnet-5-5"  # binding default of snapshot
    assert snapshot_serves_model(snapshot, "claude-haiku-4-5")
    assert not snapshot_serves_model(snapshot, "gpt-5-4")
    assert snapshot_serves_model(None, "anything")


def test_a_model_connection_is_never_filtered_by_name() -> None:
    """A connection's ids are its upstream's names: claude-sdk is offered all of them; an
    operator gateway's curated list keeps the rule for ids recognizably of another vendor."""
    service = SandboxInferenceService(SimpleNamespace())
    allow = ("claude-sonnet-5-5", "gateway/fast", "gpt-5-4", "team-model")
    for connection, expected in (
        (True, list(allow)),
        (False, ["claude-sonnet-5-5", "gateway/fast", "team-model"]),
    ):
        result = service._static_catalog(
            {"provider_label": "x"},
            HarnessInferenceBinding("gw", None, allow),
            ProviderEntry(name="gw", kind="gateway"),
            "claude-sdk",
            connection=connection,
        )
        assert [row["id"] for row in result["models"]] == expected


def test_providers_are_the_engines_registry(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    client = TestClient(app)
    monkeypatch.delenv("LITELLM_BASE_URL", raising=False)
    data = client.get("/v1/me/model-providers").json()["data"]
    assert data == [
        {"provider": "anthropic", "label": "Anthropic", "operator_key": False},
        {"provider": "openrouter", "label": "OpenRouter", "operator_key": False},
    ]
    # An operator-run upstream is offered once it is configured.
    monkeypatch.setenv("LITELLM_BASE_URL", "http://litellm.internal:4000")
    names = [p["provider"] for p in client.get("/v1/me/model-providers").json()["data"]]
    assert names == ["anthropic", "openrouter", "litellm"]


def test_helper_models_answer_the_owners_light_and_default(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    from omnigent.superchat.models import tiers

    prices = {"claude-sonnet-5-5": (3e-6, 15e-6), "claude-haiku-4-5": (1e-6, 5e-6)}
    monkeypatch.setattr(tiers, "catalog_price", prices.get)
    client = TestClient(app)

    def ask(harness: str) -> dict:
        return client.get("/v1/sessions/s1/helper-models", params={"harness": harness}).json()

    # fast: the cheapest; strong: the catalog default (nothing picked).
    assert ask("claude-sdk") == {"fast": "claude-haiku-4-5", "strong": "claude-sonnet-5-5"}
    # strong follows the person's Default; fast their Light pick.
    app.state.model_preference_store.set(
        "local", {"claude-sdk": "claude-haiku-4-5"}, {"claude-sdk": "claude-sonnet-5-5"}
    )
    assert ask("claude-sdk") == {"fast": "claude-sonnet-5-5", "strong": "claude-haiku-4-5"}
    assert ask("nope") == {"fast": None, "strong": None}
