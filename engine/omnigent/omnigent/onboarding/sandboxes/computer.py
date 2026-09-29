"""
Nova "computer" sandbox launcher.

Runs an Omnigent managed host inside a Muse's own per-Muse sandbox computer — Nova's
persistent, shared compute for one Muse (bot), managed by Nova's own
``infra/sandboxes/supervisor`` service (a small HTTP API in front of Docker; see
``infra/sandboxes/computer`` for the image). This is the "computer" runner location
(docs/omnigent-spike.md): Omnigent runners execute inside the Muse's own sandbox, not on the
Omnigent server and not on the host machine running it.

Implements :class:`~omnigent.onboarding.sandboxes.base.SandboxHostLauncher` (via
:class:`~omnigent.onboarding.sandboxes.base.ExecModelHostLauncher`, whose default
:meth:`~omnigent.onboarding.sandboxes.base.ExecModelHostLauncher.start_host` composes ``run`` /
``run_background`` into the full host launch) exactly like every other managed-sandbox provider
(Modal, Boxlite, …) — ``managed_launch`` only; no CLI-bootstrap primitives (``put`` /
``stream_exec`` / ``exec_foreground`` stay the raising defaults).

Identity: unlike every other provider, this launcher's sandbox is not a fresh box it creates —
it is a PRE-EXISTING, Nova-owned resource keyed by the session's Muse, not by the launch-chosen
``name`` :meth:`SandboxHostLauncher.provision` normally receives. Nova's gateway stamps every
Omnigent session with ``nova.bot`` / ``nova.user`` / ``nova.space`` labels (see
``packages/adapters/src/omnigent/gateway.ts``); :meth:`prepare_for_launch` is the extension point
:mod:`omnigent.server.managed_hosts` already threads a first launch's session labels through, and
this launcher reads ``nova.bot`` / ``nova.space`` off them. A RELAUNCH (existing host, fresh
sandbox generation — see :func:`omnigent.server.managed_hosts.relaunch_managed_host`) has no
session labels handy, so it instead passes ``previous_sandbox_id`` — this launcher's own encoded
:meth:`provision` return value from the earlier launch — and recovers the same identity from it.

Sandbox id shape: ``"<bot_id>:<space_id>:<container_id>"``. The first two segments are the
Muse's identity (recoverable on relaunch, see above); the third is Nova supervisor's own
container id, needed by every ``/computers/{id}/...`` call after ``provision``.

Authentication, both directions:

- Omnigent → Nova's supervisor: a static bearer (``OMNIGENT_NOVA_SUPERVISOR_TOKEN``) plus the
  ``x-aiden-bot-id`` / ``x-aiden-space-id`` identity headers the supervisor cross-checks against
  the container it resolves — the same shared-secret posture
  ``packages/adapters/src/docker-sandbox.ts`` already uses from Nova's own API process
  (``resolveSupervisorToken`` / ``SANDBOX_SUPERVISOR_TOKEN``). Never a per-user secret: the
  supervisor has no concept of an Omnigent session owner, only a Muse.
- The runner → Omnigent server: the STANDARD managed-host launch token
  (:data:`~omnigent.host.identity.HOST_TOKEN_ENV_VAR`, minted per launch by
  :mod:`omnigent.server.managed_hosts` and registered against this session's owner in
  :class:`~omnigent.stores.host_store.HostStore`) — the same short-lived, owner-scoped,
  per-launch credential every managed provider's host already dials back with. This launcher
  adds nothing here: ``start_host``'s inherited default already injects it, and it is exactly
  "never a long-lived admin secret, minted for the session owner."

Idempotent: :meth:`provision` calls Nova supervisor's ``POST /computers``, which itself is an
ensure-or-create (returns the already-running container, starting it back up if merely stopped,
rather than replacing it) — repeated launches for the same Muse reuse the same computer without
this launcher needing its own liveness bookkeeping. ``start_host``'s ``run_background`` wraps the
host process in the shared restart-on-crash supervisor loop
(:func:`~omnigent.onboarding.sandboxes.base.supervise_host_command`), so a crashed host process
self-heals inside the SAME container without a fresh launch at all.

Deliberately does NOT implement
:meth:`~omnigent.onboarding.sandboxes.base.SandboxLifecycle.terminate` (nor
:meth:`~omnigent.onboarding.sandboxes.base.SandboxLifecycle.keep_alive`): the computer belongs
to Nova and outlives any one Omnigent session (skills, canvas, and browser use share it too) —
Omnigent's best-effort sandbox cleanup (a session deleted mid-provision, the managed sandbox
reaper) must never destroy it. The base class's capability-error default is exactly "this
provider can't do that" from Omnigent's side, which every caller already treats as
best-effort/skippable.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, ClassVar
from urllib.parse import quote

import click
import httpx

from omnigent.onboarding.sandboxes.base import ExecModelHostLauncher, RemoteCommandResult
from omnigent.onboarding.sandboxes.types import SandboxCapabilities, SandboxError

if TYPE_CHECKING:
    from collections.abc import Mapping

_logger = logging.getLogger(__name__)

SUPERVISOR_URL_ENV_VAR: str = "OMNIGENT_NOVA_SUPERVISOR_URL"
"""Base URL of Nova's sandbox supervisor, e.g. ``"http://sandbox-supervisor:7091"``
(``infra/sandboxes/supervisor``)."""

SUPERVISOR_TOKEN_ENV_VAR: str = "OMNIGENT_NOVA_SUPERVISOR_TOKEN"
"""Shared bearer the supervisor expects on every request — the same secret Nova's own API
process reads via ``resolveSupervisorToken``/``SANDBOX_SUPERVISOR_TOKEN`` (see
``packages/core/src/secrets-guard.ts``). Never a per-user credential."""

HOME_ROOT_ENV_VAR: str = "OMNIGENT_NOVA_HOME_ROOT"
"""Root directory a Muse's persistent home lives under, joined as ``<root>/homes/<bot_id>`` —
must resolve to the SAME host path Nova's own API process uses (``dataDir`` in
``packages/adapters/src/home.ts``'s ``resolveAgentHomePath``), since both processes provision
containers for the very same Muse. Defaults to ``"./data"`` (Nova API's own default) only for
local/dev parity; a real deployment should set this to an absolute, shared path."""

_DEFAULT_HOME_ROOT: str = "./data"

_REQUEST_TIMEOUT_S: float = 30.0
_PROVISION_TIMEOUT_S: float = 120.0
_EXEC_TIMEOUT_S: float = 300.0
_EXEC_TIMEOUT_MS: int = int(_EXEC_TIMEOUT_S * 1000)

# Response bodies are echoed into ClickException messages; capped so a misbehaving supervisor
# (or an accidental HTML error page) can't flood the CLI/log with megabytes of text.
_MAX_ERROR_BODY_CHARS: int = 500


class ComputerSandboxError(SandboxError):
    """A call to Nova's sandbox supervisor failed."""


def _parse_sandbox_id(sandbox_id: str) -> tuple[str, str, str]:
    """
    Split a launcher-issued sandbox id into ``(bot_id, space_id, container_id)``.

    :param sandbox_id: A value :meth:`ComputerSandboxLauncher.provision` returned, e.g.
        ``"bot_abc:space_xyz:a1b2c3d4e5f6"``.
    :returns: The three segments, in order.
    :raises click.ClickException: When *sandbox_id* is not exactly three colon-joined segments —
        it was not issued by this launcher (or is corrupted).
    """
    parts = sandbox_id.split(":", 2)
    if len(parts) != 3 or not all(parts):
        raise click.ClickException(
            f"malformed 'computer' sandbox id {sandbox_id!r} — expected "
            "'<bot_id>:<space_id>:<container_id>'"
        )
    bot_id, space_id, container_id = parts
    return bot_id, space_id, container_id


class ComputerSandboxLauncher(ExecModelHostLauncher):
    """
    Sandbox launcher that runs Omnigent hosts inside a Muse's Nova computer.

    See the module docstring for the full design. Registered as the ``"computer"`` sandbox
    provider (:mod:`omnigent.onboarding.sandboxes.registry`); select it with
    ``sandbox.provider: computer`` (or in a ``sandbox.providers` list) in the server config —
    it needs no ``sandbox.computer:`` block, only the two environment variables above, mirroring
    how the Modal launcher reads ``MODAL_TOKEN_ID``/``MODAL_TOKEN_SECRET`` from the process
    environment rather than server YAML.
    """

    provider: ClassVar[str] = "computer"
    supports_cli_bootstrap: ClassVar[bool] = False
    supports_managed_launch: ClassVar[bool] = True

    def __init__(
        self,
        *,
        supervisor_url: str | None = None,
        supervisor_token: str | None = None,
        home_root: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        """
        :param supervisor_url: Override for :data:`SUPERVISOR_URL_ENV_VAR` (tests / embedding
            deployments that construct this launcher directly instead of through server YAML).
        :param supervisor_token: Override for :data:`SUPERVISOR_TOKEN_ENV_VAR`.
        :param home_root: Override for :data:`HOME_ROOT_ENV_VAR`.
        :param client: Pre-built HTTP client, e.g. one wired to a fake supervisor via
            ``httpx.MockTransport`` in tests. ``None`` builds a real client against
            *supervisor_url* lazily on first use.
        """
        self._supervisor_url = (
            supervisor_url
            if supervisor_url is not None
            else os.environ.get(SUPERVISOR_URL_ENV_VAR, "")
        ).rstrip("/")
        self._supervisor_token = (
            supervisor_token
            if supervisor_token is not None
            else os.environ.get(SUPERVISOR_TOKEN_ENV_VAR, "")
        )
        self._home_root = (
            home_root if home_root is not None else os.environ.get(HOME_ROOT_ENV_VAR, "")
        ) or _DEFAULT_HOME_ROOT
        self._injected_client = client
        # Set by prepare_for_launch before provision() needs them; provision() is the only
        # method that relies on this instance state (every other method re-derives identity
        # from the sandbox_id it is handed, so it works even if called on a fresh instance).
        self._bot_id: str | None = None
        self._space_id: str | None = None

    @property
    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(managed_launch=True)

    def prepare_for_launch(
        self,
        *,
        agent_name: str | None = None,
        labels: Mapping[str, str] | None = None,
        previous_sandbox_id: str | None = None,
    ) -> None:
        """
        Resolve this launch's target Muse from session labels, or a relaunch's prior sandbox id.

        A first launch supplies *labels* (the session's ``nova.bot`` / ``nova.space`` — see the
        module docstring); a relaunch of an existing host supplies *previous_sandbox_id* instead
        (no session labels are threaded to that path). *labels* wins when both are present, since
        it reflects the CURRENT session row rather than whatever an earlier launch encoded.
        Neither resolving leaves identity unset — :meth:`prepare` then fails loud rather than
        :meth:`provision` doing so with a less legible error.

        :param agent_name: Unused — this provider does not classify runners by agent.
        :param labels: The launching session's labels, or ``None``.
        :param previous_sandbox_id: The host's previous :meth:`provision` return value, on a
            relaunch, or ``None`` for a first launch.
        """
        del agent_name
        bot_id = (labels or {}).get("nova.bot")
        space_id = (labels or {}).get("nova.space")
        if bot_id and space_id:
            self._bot_id, self._space_id = bot_id, space_id
            return
        if previous_sandbox_id:
            self._bot_id, self._space_id, _container_id = _parse_sandbox_id(previous_sandbox_id)

    def prepare(self) -> None:
        if not self._supervisor_url:
            raise click.ClickException(
                f"{SUPERVISOR_URL_ENV_VAR} is not set — the 'computer' sandbox provider needs "
                "Nova's sandbox supervisor URL (see docs/omnigent-spike.md)"
            )
        if not self._supervisor_token:
            raise click.ClickException(
                f"{SUPERVISOR_TOKEN_ENV_VAR} is not set — the 'computer' sandbox provider needs "
                "the shared secret Nova's sandbox supervisor expects on every request"
            )
        if not self._bot_id or not self._space_id:
            raise click.ClickException(
                "the 'computer' sandbox provider could not resolve this Muse's identity — the "
                "launching session must carry 'nova.bot' and 'nova.space' labels "
                "(packages/adapters/src/omnigent/gateway.ts)"
            )

    def _client(self) -> httpx.Client:
        if self._injected_client is not None:
            return self._injected_client
        # Built lazily (not in __init__): the registry factory constructs one launcher per
        # launch attempt regardless of whether it ever calls out, matching every other
        # provider's lazy-SDK-import posture.
        self._injected_client = httpx.Client(base_url=self._supervisor_url)
        return self._injected_client

    def _request(
        self, method: str, path: str, *, bot_id: str, space_id: str, **kwargs: object
    ) -> httpx.Response:
        headers = {
            "authorization": f"Bearer {self._supervisor_token}",
            "x-aiden-bot-id": bot_id,
            "x-aiden-space-id": space_id,
        }
        kwargs.setdefault("timeout", _REQUEST_TIMEOUT_S)
        try:
            return self._client().request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise click.ClickException(
                f"Nova sandbox supervisor request failed ({method} {path}): {exc}"
            ) from exc

    @staticmethod
    def _error_detail(response: httpx.Response) -> str:
        try:
            return response.text[:_MAX_ERROR_BODY_CHARS]
        except Exception:
            # Best-effort error text for a ClickException message; never worth failing over.
            return ""

    def provision(self, name: str) -> str:
        """
        Ensure this Muse's computer is running and return its encoded sandbox id.

        :param name: Unused — Nova's supervisor keys containers by ``(botId, spaceId)``, not by
            the launch-chosen human label every other provider uses.
        """
        del name
        if not self._bot_id or not self._space_id:
            # prepare() already enforces this before provision() ever runs; guards mypy/pyrefly
            # narrowing below rather than signaling a real reachable state.
            raise click.ClickException("the 'computer' sandbox provider has no Muse identity")
        home_path = os.path.join(self._home_root, "homes", self._bot_id)
        response = self._request(
            "POST",
            "/computers",
            bot_id=self._bot_id,
            space_id=self._space_id,
            json={"botId": self._bot_id, "homePath": home_path, "spaceId": self._space_id},
            timeout=_PROVISION_TIMEOUT_S,
        )
        if response.status_code >= 400:
            raise click.ClickException(
                "Nova sandbox supervisor could not ensure this Muse's computer "
                f"({response.status_code}): {self._error_detail(response)}"
            )
        body = response.json()
        container_id = body.get("id")
        if not isinstance(container_id, str) or not container_id:
            raise click.ClickException(
                "Nova sandbox supervisor's computer response carried no container id"
            )
        return f"{self._bot_id}:{self._space_id}:{container_id}"

    def run(self, sandbox_id: str, command: str, *, check: bool = True) -> RemoteCommandResult:
        bot_id, space_id, container_id = _parse_sandbox_id(sandbox_id)
        response = self._request(
            "POST",
            f"/computers/{quote(container_id, safe='')}/exec",
            bot_id=bot_id,
            space_id=space_id,
            json={"argv": ["sh", "-c", command], "timeoutMs": _EXEC_TIMEOUT_MS},
            timeout=_EXEC_TIMEOUT_S + _REQUEST_TIMEOUT_S,
        )
        if response.status_code >= 400:
            result = RemoteCommandResult(
                returncode=1,
                stdout="",
                stderr=f"exec request failed ({response.status_code}): "
                f"{self._error_detail(response)}",
            )
        else:
            body = response.json()
            result = RemoteCommandResult(
                returncode=int(body.get("code", 1)),
                stdout=str(body.get("stdout") or ""),
                stderr=str(body.get("stderr") or ""),
            )
        if check and result.returncode != 0:
            raise click.ClickException(
                f"command failed in Nova computer (exit {result.returncode}): "
                f"{(result.stderr or result.stdout).strip()}"
            )
        return result

    def is_running(self, sandbox_id: str) -> bool | None:
        """Cheap liveness check via ``GET /computers/{id}`` — ``None`` on any request failure
        (unknown, not a definitive answer), matching the base class's documented contract."""
        try:
            bot_id, space_id, container_id = _parse_sandbox_id(sandbox_id)
            response = self._request(
                "GET",
                f"/computers/{quote(container_id, safe='')}",
                bot_id=bot_id,
                space_id=space_id,
            )
        except click.ClickException:
            return None
        if response.status_code >= 400:
            return None
        try:
            return bool(response.json().get("running"))
        except ValueError:
            return None
