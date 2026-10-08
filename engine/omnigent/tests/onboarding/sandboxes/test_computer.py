"""Tests for :mod:`omnigent.onboarding.sandboxes.computer`.

Fully offline: every HTTP call goes through ``httpx.MockTransport`` against a fake supervisor
handler — no real Nova supervisor, network, or Docker daemon involved.
"""

from __future__ import annotations

import json

import click
import httpx
import pytest

from omnigent.onboarding.sandboxes.base import ExecModelHostLauncher
from omnigent.onboarding.sandboxes.computer import (
    HOME_ROOT_ENV_VAR,
    SUPERVISOR_TOKEN_ENV_VAR,
    SUPERVISOR_URL_ENV_VAR,
    ComputerSandboxLauncher,
    _parse_sandbox_id,
)

BOT_ID = "bot_abc123"
SPACE_ID = "space_xyz789"
CONTAINER_ID = "c0ffee1234567890"
SANDBOX_ID = f"{BOT_ID}:{SPACE_ID}:{CONTAINER_ID}"


class FakeSupervisor:
    """Records every request and answers like Nova's real sandbox supervisor would.

    :param computers_status: HTTP status ``POST /computers`` returns.
    :param computers_body: JSON body ``POST /computers`` returns on success.
    :param exec_status: HTTP status the exec endpoint returns.
    :param exec_body: JSON body the exec endpoint returns on success.
    """

    def __init__(
        self,
        *,
        computers_status: int = 200,
        computers_body: dict[str, object] | None = None,
        exec_status: int = 200,
        exec_body: dict[str, object] | None = None,
        running: bool = True,
    ) -> None:
        self.requests: list[httpx.Request] = []
        self.computers_status = computers_status
        self.computers_body = computers_body or {
            "id": CONTAINER_ID,
            "image": "nova-computer:latest",
            "resumed": True,
        }
        self.exec_status = exec_status
        self.exec_body = exec_body or {"stdout": "ok\n", "stderr": "", "code": 0}
        self.running = running

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path == "/computers" and request.method == "POST":
            return httpx.Response(self.computers_status, json=self.computers_body)
        if request.url.path.endswith("/exec") and request.method == "POST":
            return httpx.Response(self.exec_status, json=self.exec_body)
        if request.method == "GET" and request.url.path.startswith("/computers/"):
            return httpx.Response(200, json={"id": CONTAINER_ID, "running": self.running})
        return httpx.Response(404, json={"error": "not found"})

    def client(self) -> httpx.Client:
        return httpx.Client(
            transport=httpx.MockTransport(self.handler), base_url="http://supervisor.test"
        )


def make_launcher(supervisor: FakeSupervisor, **kwargs: object) -> ComputerSandboxLauncher:
    return ComputerSandboxLauncher(
        supervisor_url="http://supervisor.test",
        supervisor_token="shared-secret",
        client=supervisor.client(),
        **kwargs,
    )


def test_parse_sandbox_id_round_trips() -> None:
    assert _parse_sandbox_id(SANDBOX_ID) == (BOT_ID, SPACE_ID, CONTAINER_ID)


@pytest.mark.parametrize("malformed", ["", "bot_only", "bot:space", "bot::", ":space:container"])
def test_parse_sandbox_id_rejects_malformed_ids(malformed: str) -> None:
    with pytest.raises(click.ClickException):
        _parse_sandbox_id(malformed)


def test_prepare_for_launch_resolves_identity_from_labels() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    launcher.prepare()  # Does not raise: identity resolved.


def test_prepare_for_launch_targets_novas_computer_key_when_given() -> None:
    """Team mode shares one computer per space: the runner must land on that same machine."""
    launcher = make_launcher(FakeSupervisor())
    launcher.prepare_for_launch(
        labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID, "nova.computer": "team-space_1"}
    )
    assert (launcher._bot_id, launcher._space_id) == ("team-space_1", SPACE_ID)


def test_prepare_for_launch_reads_generic_labels() -> None:
    launcher = make_launcher(FakeSupervisor())
    launcher.prepare_for_launch(
        labels={
            "omnigent.computer.key": "team-1",
            "omnigent.computer.owner": "owner-1",
            "omnigent.tenant": "tenant-1",
            "nova.bot": "ignored",
            "nova.space": "ignored",
        }
    )
    assert (launcher._bot_id, launcher._space_id) == ("team-1", "tenant-1")


def test_prepare_for_launch_owner_label_is_the_key_when_no_key_label() -> None:
    launcher = make_launcher(FakeSupervisor())
    launcher.prepare_for_launch(
        labels={"omnigent.computer.owner": "owner-1", "omnigent.tenant": "tenant-1"}
    )
    assert (launcher._bot_id, launcher._space_id) == ("owner-1", "tenant-1")


def test_deprecated_env_names_still_configure_the_launcher(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(SUPERVISOR_URL_ENV_VAR, raising=False)
    monkeypatch.delenv("OMNIGENT_COMPUTER_SUPERVISOR_TOKEN", raising=False)
    monkeypatch.setenv("OMNIGENT_NOVA_SUPERVISOR_URL", "http://old.test/")
    monkeypatch.setenv("OMNIGENT_NOVA_SUPERVISOR_TOKEN", "old-token")
    launcher = ComputerSandboxLauncher()
    assert launcher._supervisor_url == "http://old.test"
    assert launcher._supervisor_token == "old-token"
    monkeypatch.setenv(SUPERVISOR_URL_ENV_VAR, "http://new.test")
    assert ComputerSandboxLauncher()._supervisor_url == "http://new.test"


def test_prepare_for_launch_recovers_identity_from_previous_sandbox_id_on_relaunch() -> None:
    """A relaunch has no session labels handy; it passes back this launcher's own earlier
    provision() return value instead, and identity must still resolve from that alone."""
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    launcher.prepare_for_launch(labels=None, previous_sandbox_id=SANDBOX_ID)
    launcher.prepare()


def test_prepare_for_launch_prefers_labels_over_previous_sandbox_id() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    launcher.prepare_for_launch(
        labels={"nova.bot": "bot_fresh", "nova.space": "space_fresh"},
        previous_sandbox_id=SANDBOX_ID,
    )
    sandbox_id = launcher.provision("ignored")
    assert sandbox_id.startswith("bot_fresh:space_fresh:")


def test_prepare_fails_loud_without_supervisor_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SUPERVISOR_URL_ENV_VAR, raising=False)
    monkeypatch.delenv(SUPERVISOR_TOKEN_ENV_VAR, raising=False)
    launcher = ComputerSandboxLauncher(supervisor_token="secret")
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    with pytest.raises(click.ClickException, match=SUPERVISOR_URL_ENV_VAR):
        launcher.prepare()


def test_prepare_fails_loud_without_supervisor_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SUPERVISOR_TOKEN_ENV_VAR, raising=False)
    launcher = ComputerSandboxLauncher(supervisor_url="http://supervisor.test")
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    with pytest.raises(click.ClickException, match=SUPERVISOR_TOKEN_ENV_VAR):
        launcher.prepare()


def test_prepare_fails_loud_without_resolved_identity() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    # No prepare_for_launch call at all — the identity-resolution step never ran.
    with pytest.raises(click.ClickException, match="identity"):
        launcher.prepare()


def test_launcher_reads_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(SUPERVISOR_URL_ENV_VAR, "http://from-env.test")
    monkeypatch.setenv(SUPERVISOR_TOKEN_ENV_VAR, "env-token")
    monkeypatch.setenv(HOME_ROOT_ENV_VAR, "/data/nova")
    launcher = ComputerSandboxLauncher()
    assert launcher._supervisor_url == "http://from-env.test"
    assert launcher._supervisor_token == "env-token"
    assert launcher._home_root == "/data/nova"


def test_provision_ensures_the_computer_and_returns_an_encoded_sandbox_id() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor, home_root="/data/nova")
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    launcher.prepare()

    sandbox_id = launcher.provision("managed-abc12345")

    assert sandbox_id == SANDBOX_ID
    assert len(supervisor.requests) == 1
    request = supervisor.requests[0]
    assert request.method == "POST"
    assert request.url.path == "/computers"
    assert request.headers["authorization"] == "Bearer shared-secret"
    assert request.headers["x-nova-bot-id"] == BOT_ID
    assert request.headers["x-nova-space-id"] == SPACE_ID
    import json

    body = json.loads(request.content)
    assert body == {
        "botId": BOT_ID,
        "homePath": "/data/nova/homes/bot_abc123",
        "spaceId": SPACE_ID,
    }


def test_provision_is_idempotent_across_repeated_calls_like_ensure_semantics() -> None:
    """Nova's supervisor POST /computers is itself an ensure-or-create; repeated launches for
    the same Muse reuse the running container without this launcher tracking anything."""
    supervisor = FakeSupervisor(computers_body={"id": CONTAINER_ID, "resumed": True})
    launcher = make_launcher(supervisor)
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    launcher.prepare()

    first = launcher.provision("name-1")
    second = launcher.provision("name-2")

    assert first == second == SANDBOX_ID
    assert len(supervisor.requests) == 2


def test_provision_raises_clearly_on_supervisor_error() -> None:
    supervisor = FakeSupervisor(computers_status=500, computers_body={"error": "docker is down"})
    launcher = make_launcher(supervisor)
    launcher.prepare_for_launch(labels={"nova.bot": BOT_ID, "nova.space": SPACE_ID})
    launcher.prepare()

    with pytest.raises(click.ClickException, match="docker is down"):
        launcher.provision("managed-abc")


def test_run_execs_the_command_through_the_supervisor() -> None:
    supervisor = FakeSupervisor(exec_body={"stdout": "hello\n", "stderr": "", "code": 0})
    launcher = make_launcher(supervisor)

    result = launcher.run(SANDBOX_ID, "echo hello")

    assert result.returncode == 0
    assert result.stdout == "hello\n"
    request = supervisor.requests[-1]
    assert request.url.path == f"/computers/{CONTAINER_ID}/exec"
    assert request.headers["x-nova-bot-id"] == BOT_ID
    assert request.headers["x-nova-space-id"] == SPACE_ID
    import json

    body = json.loads(request.content)
    assert body["argv"] == ["sh", "-c", "echo hello"]


def test_run_raises_on_nonzero_exit_when_check_is_true() -> None:
    supervisor = FakeSupervisor(exec_body={"stdout": "", "stderr": "boom", "code": 1})
    launcher = make_launcher(supervisor)

    with pytest.raises(click.ClickException, match="boom"):
        launcher.run(SANDBOX_ID, "false")


def test_run_does_not_raise_on_nonzero_exit_when_check_is_false() -> None:
    supervisor = FakeSupervisor(exec_body={"stdout": "", "stderr": "boom", "code": 1})
    launcher = make_launcher(supervisor)

    result = launcher.run(SANDBOX_ID, "false", check=False)

    assert result.returncode == 1


def test_run_sends_env_as_a_separate_exec_field_not_in_argv() -> None:
    """``env`` must ride the exec request's own ``env`` field — never interpolated into the
    shell command — so a secret value never appears in argv/``ps`` or in the request body's
    command string."""
    supervisor = FakeSupervisor(exec_body={"stdout": "ok\n", "stderr": "", "code": 0})
    launcher = make_launcher(supervisor)

    launcher.run(SANDBOX_ID, "echo hello", env={"ANTHROPIC_API_KEY": "sk-secret"})

    request = supervisor.requests[-1]
    import json

    body = json.loads(request.content)
    assert body["env"] == {"ANTHROPIC_API_KEY": "sk-secret"}
    assert "sk-secret" not in json.dumps(body["argv"])


def test_run_omits_the_env_field_when_none_is_given() -> None:
    supervisor = FakeSupervisor(exec_body={"stdout": "ok\n", "stderr": "", "code": 0})
    launcher = make_launcher(supervisor)

    launcher.run(SANDBOX_ID, "echo hello")

    request = supervisor.requests[-1]
    import json

    body = json.loads(request.content)
    assert "env" not in body


def test_run_background_wraps_the_command_and_returns_immediately() -> None:
    """The inherited default run_background() backgrounds the omnigent host process inside the
    container via setsid/nohup — this launcher needs no override for that to work, as long as
    run() itself behaves like a synchronous shell exec (which the supervisor's /exec does)."""
    supervisor = FakeSupervisor(exec_body={"stdout": "launched\n", "stderr": "", "code": 0})
    launcher = make_launcher(supervisor)

    result = launcher.run_background(
        SANDBOX_ID, "OMNIGENT_HOST_TOKEN=tok omnigent host --server https://example.test"
    )

    assert result.stdout == "launched\n"
    request = supervisor.requests[-1]
    import json

    body = json.loads(request.content)
    assert body["argv"][0] == "sh"
    assert body["argv"][1] == "-c"
    # Backgrounded via setsid/nohup and detached from the exec's own process group, matching
    # every other exec-model provider's run_background wrapper.
    assert "setsid nohup sh -c" in body["argv"][2]
    assert "omnigent host --server" in body["argv"][2]


def test_is_running_reports_true_when_the_supervisor_says_so() -> None:
    supervisor = FakeSupervisor(running=True)
    launcher = make_launcher(supervisor)
    assert launcher.is_running(SANDBOX_ID) is True


def test_is_running_reports_false_when_the_supervisor_says_so() -> None:
    supervisor = FakeSupervisor(running=False)
    launcher = make_launcher(supervisor)
    assert launcher.is_running(SANDBOX_ID) is False


def test_is_running_returns_none_on_a_malformed_sandbox_id() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    assert launcher.is_running("not-a-valid-id") is None


def test_terminate_is_not_supported_since_the_computer_outlives_the_session() -> None:
    """The computer is Nova's, not this launch's, to destroy — Omnigent's best-effort cleanup
    (session deleted mid-provision, the managed-sandbox reaper) must never tear it down."""
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    with pytest.raises(click.ClickException):
        launcher.terminate(SANDBOX_ID)
    assert supervisor.requests == []


def test_capabilities_declare_managed_launch_only() -> None:
    supervisor = FakeSupervisor()
    launcher = make_launcher(supervisor)
    caps = launcher.capabilities
    assert caps.managed_launch is True
    assert caps.cli_bootstrap is False
    assert caps.resume_stopped is False
    assert caps.programmatic_terminate is False


# ── stale container id, screen, DISPLAY ──────────────────────────────────────────────────

NEW_CONTAINER_ID = "beefbeefbeef"


def stale_container_launcher(
    requests: list[httpx.Request], *, screen_body: dict[str, object] | None = None
) -> ComputerSandboxLauncher:
    """Fake supervisor whose container was recreated: the old id 404s, POST /computers
    returns the new id, and calls on the new id succeed."""

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path == "/computers":
            return httpx.Response(200, json={"id": NEW_CONTAINER_ID})
        if f"/{CONTAINER_ID}" in path:
            return httpx.Response(404, json={"error": "No such container"})
        if path.endswith("/screen-mode"):
            return httpx.Response(
                200, json=screen_body or {"screenUrl": "http://v/?t=1", "display": ":3"}
            )
        if path.endswith("/exec"):
            return httpx.Response(200, json={"stdout": "ok", "stderr": "", "code": 0})
        return httpx.Response(200, json={"running": True})

    return ComputerSandboxLauncher(
        supervisor_url="http://supervisor.test",
        supervisor_token="shared-secret",
        client=httpx.Client(
            transport=httpx.MockTransport(handler), base_url="http://supervisor.test"
        ),
    )


def test_run_re_resolves_a_stale_container_id_and_retries() -> None:
    requests: list[httpx.Request] = []
    launcher = stale_container_launcher(requests)
    assert launcher.run(SANDBOX_ID, "echo ok").stdout == "ok"
    assert [r.url.path for r in requests] == [
        f"/computers/{CONTAINER_ID}/exec",
        "/computers",
        f"/computers/{NEW_CONTAINER_ID}/exec",
    ]
    ensure = requests[1]
    assert ensure.headers["x-nova-bot-id"] == BOT_ID
    assert ensure.headers["x-nova-space-id"] == SPACE_ID


def test_is_running_re_resolves_a_stale_container_id() -> None:
    launcher = stale_container_launcher([])
    assert launcher.is_running(SANDBOX_ID) is True


def test_screen_url_sends_the_stable_screen_id_and_view_mode() -> None:
    requests: list[httpx.Request] = []
    launcher = stale_container_launcher(requests)
    assert launcher.screen_url(SANDBOX_ID, interactive=False) == "http://v/?t=1"
    screen = requests[-1]
    assert screen.url.path == f"/computers/{NEW_CONTAINER_ID}/screen-mode"
    assert screen.headers["x-nova-screen-id"] == BOT_ID
    assert json.loads(screen.content) == {"interactive": False, "revokeControl": False}


def test_screen_url_interactive_passes_the_control_token() -> None:
    requests: list[httpx.Request] = []
    launcher = stale_container_launcher(requests)
    launcher.screen_url(SANDBOX_ID, interactive=True, control_token="tok_1")
    assert json.loads(requests[-1].content) == {"interactive": True, "controlToken": "tok_1"}


def test_screen_url_interactive_requires_a_token() -> None:
    launcher = stale_container_launcher([])
    with pytest.raises(click.ClickException):
        launcher.screen_url(SANDBOX_ID, interactive=True)


def test_release_control_revokes_interactive_access() -> None:
    requests: list[httpx.Request] = []
    launcher = stale_container_launcher(requests)
    launcher.release_control(SANDBOX_ID)
    assert json.loads(requests[-1].content) == {"interactive": False, "revokeControl": True}


def test_start_host_passes_the_screen_display_to_the_runner_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    launcher = stale_container_launcher([])
    seen: dict[str, object] = {}

    def fake_start_host(self: object, sandbox_id: str, **kwargs: object) -> str:
        seen.update(kwargs)
        return "/ws"

    monkeypatch.setattr(ExecModelHostLauncher, "start_host", fake_start_host)
    assert launcher.start_host(SANDBOX_ID, token="t", runner_env={"A": "1"}) == "/ws"
    assert seen["runner_env"] == {"A": "1", "DISPLAY": ":3"}


def test_ensure_display_falls_back_when_the_supervisor_omits_it() -> None:
    launcher = stale_container_launcher([], screen_body={"screenUrl": "http://v/"})
    assert launcher.ensure_display(SANDBOX_ID) == ":1"


def test_capabilities_declare_screen() -> None:
    assert make_launcher(FakeSupervisor()).capabilities.screen is True
