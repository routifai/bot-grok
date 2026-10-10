"""
"Computer" sandbox launcher: one Omnigent runner container per person, on plain Docker.

A person's Computer is a long-lived container started from the runner image (Omnigent's host
image plus the deployment's additions), with the person's home on a named Docker volume. The
engine talks to the Docker Engine API over its socket directly; nothing sits in between. This is
the Docker counterpart of the Kubernetes provider: same runner image, a container instead of a pod.

Implements :class:`~omnigent.onboarding.sandboxes.base.SandboxHostLauncher` (via
:class:`~omnigent.onboarding.sandboxes.base.ExecModelHostLauncher`, whose default
:meth:`~omnigent.onboarding.sandboxes.base.ExecModelHostLauncher.start_host` composes ``run`` /
``run_background`` into the full host launch) — ``managed_launch`` only.

Identity: the Computer is keyed by the session's person, not by the launch-chosen ``name``. The
gateway stamps every session with ``omnigent.computer.key`` / ``omnigent.computer.owner`` /
``omnigent.tenant`` labels (the older ``superchat.*`` labels are still read, deprecated, removal
in 0.19); :meth:`prepare_for_launch` reads them, or on a relaunch recovers them from the previous
sandbox id ``"<key>:<tenant>:<container_id>"``.

Idempotent: :meth:`provision` reuses the person's container (starting it if stopped) and only
recreates it when the runner image changed; the home volume survives a recreate. ``start_host``
wraps the host process in the shared restart-on-crash loop, so a crashed host self-heals inside
the same container.

Deliberately does NOT implement ``terminate`` / ``keep_alive``: the Computer outlives any one
session, and Omnigent's best-effort sandbox cleanup must never destroy it.
"""

from __future__ import annotations

import logging
import os
import re
import struct
from typing import TYPE_CHECKING, Any, ClassVar
from urllib.parse import quote

import click
import httpx

from omnigent.onboarding.sandboxes.base import (
    ExecModelHostLauncher,
    RemoteCommandResult,
    supervised_host_pidfile_path,
)
from omnigent.onboarding.sandboxes.types import SandboxCapabilities, SandboxError

if TYPE_CHECKING:
    from collections.abc import Mapping

_logger = logging.getLogger(__name__)

IMAGE_ENV_VAR: str = "OMNIGENT_COMPUTER_IMAGE"
"""Runner image each Computer starts from. Defaults to ``superchat/computer:local``."""

DOCKER_SOCKET_ENV_VAR: str = "OMNIGENT_COMPUTER_DOCKER_SOCKET"
"""Path of the Docker Engine socket. Defaults to ``/var/run/docker.sock``."""

NETWORK_ENV_VAR: str = "OMNIGENT_COMPUTER_NETWORK"
"""Docker network a Computer joins. Defaults to ``bridge``."""

MEMORY_ENV_VAR: str = "OMNIGENT_COMPUTER_MEMORY"
"""Memory limit, e.g. ``2g``. Defaults to ``2g``."""

CPUS_ENV_VAR: str = "OMNIGENT_COMPUTER_CPUS"
"""CPU limit, e.g. ``2`` or ``1.5``. Defaults to ``2``."""

PIDS_LIMIT_ENV_VAR: str = "OMNIGENT_COMPUTER_PIDS_LIMIT"
"""Process limit. Defaults to ``2048``."""

LABEL_COMPUTER_KEY: str = "omnigent.computer.key"
"""Session label naming the computer to run in (shared by every session with the same key)."""

LABEL_COMPUTER_OWNER: str = "omnigent.computer.owner"
"""Session label naming the computer's owner; used as the key when no key label is set."""

LABEL_TENANT: str = "omnigent.tenant"
"""Session label naming the tenant (space) the computer belongs to."""

# Deprecated in 0.17: remove in 0.19 once clients send the ``omnigent.*`` labels.
_DEPRECATED_LABEL_COMPUTER_KEY: str = "superchat.computer"
_DEPRECATED_LABEL_COMPUTER_OWNER: str = "superchat.bot"
_DEPRECATED_LABEL_TENANT: str = "superchat.space"

_DEFAULT_IMAGE: str = "superchat/computer:local"
_DEFAULT_SOCKET: str = "/var/run/docker.sock"

#: The runner image's user and home; the home volume is mounted there.
_COMPUTER_USER: str = "1000:1000"
_COMPUTER_HOME: str = "/home/superchat"
#: The Muse's shell: the system Python (with the data stack) first, the person's own installs
#: under ~/.local before that. Omnigent's /opt/venv stays off it.
_COMPUTER_ENV: tuple[str, ...] = (
    f"HOME={_COMPUTER_HOME}",
    f"PATH={_COMPUTER_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    f"NPM_CONFIG_PREFIX={_COMPUTER_HOME}/.local",
    "PIP_USER=1",
)
_SHM_SIZE_BYTES: int = 256 * 1024 * 1024
_MANAGED_LABEL: str = "omnigent.computer"

_REQUEST_TIMEOUT_S: float = 30.0
_PROVISION_TIMEOUT_S: float = 120.0
_EXEC_TIMEOUT_S: float = 300.0

# Docker error bodies are echoed into ClickException messages; capped so a misbehaving daemon
# can't flood the log.
_MAX_ERROR_BODY_CHARS: int = 500


class ComputerSandboxError(SandboxError):
    """A call to the Docker Engine for a Computer failed."""


def tenant_from_labels(labels: Mapping[str, str]) -> str | None:
    """The tenant a session's labels place its computer in (deprecated label as fallback)."""
    return labels.get(LABEL_TENANT) or labels.get(_DEPRECATED_LABEL_TENANT) or None


def _parse_sandbox_id(sandbox_id: str) -> tuple[str, str, str]:
    """
    Split a launcher-issued sandbox id into ``(key, tenant, container_id)``.

    :param sandbox_id: A value :meth:`ComputerSandboxLauncher.provision` returned.
    :returns: The three segments, in order.
    :raises click.ClickException: When *sandbox_id* is not three non-empty colon-joined segments.
    """
    parts = sandbox_id.split(":", 2)
    if len(parts) != 3 or not all(parts):
        raise click.ClickException(
            f"malformed 'computer' sandbox id {sandbox_id!r} — expected "
            "'<key>:<tenant>:<container_id>'"
        )
    key, tenant, container_id = parts
    return key, tenant, container_id


def _safe_name(key: str) -> str:
    """A Docker-safe name fragment for *key* (letters, digits, ``_.-``; at most 40 chars)."""
    safe = re.sub(r"[^a-zA-Z0-9_.-]", "", key)[:40]
    if not safe:
        raise click.ClickException(f"computer key {key!r} has no usable characters")
    return safe


def container_name(key: str) -> str:
    """Name of the Computer container for *key*."""
    return f"superchat-computer-{_safe_name(key)}"


def home_volume_name(key: str) -> str:
    """Name of the Docker volume holding the Computer's home for *key*."""
    return f"superchat-home-{_safe_name(key)}"


def _nano_cpus(value: str) -> int:
    return int(float(value) * 1_000_000_000)


def _memory_bytes(value: str) -> int:
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([kmgKMG]?)[bB]?\s*", value)
    if not match:
        raise click.ClickException(f"{MEMORY_ENV_VAR}={value!r} is not a size like '2g'")
    number, unit = float(match.group(1)), match.group(2).lower()
    return int(number * {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3}[unit])


def _demux(stream: bytes) -> tuple[str, str]:
    """Split Docker's multiplexed exec output (8-byte frame headers) into stdout and stderr."""
    out: list[bytes] = []
    err: list[bytes] = []
    pos = 0
    while pos + 8 <= len(stream):
        kind = stream[pos]
        (size,) = struct.unpack(">I", stream[pos + 4 : pos + 8])
        chunk = stream[pos + 8 : pos + 8 + size]
        (err if kind == 2 else out).append(chunk)
        pos += 8 + size
    return (
        b"".join(out).decode("utf-8", "replace"),
        b"".join(err).decode("utf-8", "replace"),
    )


class ComputerSandboxLauncher(ExecModelHostLauncher):
    """
    Sandbox launcher that runs Omnigent hosts in a person's Computer container.

    Registered as the ``"computer"`` provider; select it with ``sandbox.provider: computer``.
    Configured only through the environment variables above.
    """

    provider: ClassVar[str] = "computer"
    supports_cli_bootstrap: ClassVar[bool] = False
    supports_managed_launch: ClassVar[bool] = True

    def __init__(
        self,
        *,
        image: str | None = None,
        socket_path: str | None = None,
        client: httpx.Client | None = None,
    ) -> None:
        """
        :param image: Override for :data:`IMAGE_ENV_VAR`.
        :param socket_path: Override for :data:`DOCKER_SOCKET_ENV_VAR`.
        :param client: Pre-built HTTP client, e.g. one wired to a fake Docker API via
            ``httpx.MockTransport`` in tests. ``None`` builds one on the socket lazily.
        """
        self._image = image or os.environ.get(IMAGE_ENV_VAR) or _DEFAULT_IMAGE
        self._socket_path = socket_path or os.environ.get(DOCKER_SOCKET_ENV_VAR) or _DEFAULT_SOCKET
        self._network = os.environ.get(NETWORK_ENV_VAR) or "bridge"
        self._memory = os.environ.get(MEMORY_ENV_VAR) or "2g"
        self._cpus = os.environ.get(CPUS_ENV_VAR) or "2"
        self._pids_limit = int(os.environ.get(PIDS_LIMIT_ENV_VAR) or "2048")
        self._injected_client = client
        # Set by prepare_for_launch; only provision() relies on it (every other method
        # re-derives identity from the sandbox id it is handed).
        self._key: str | None = None
        self._tenant: str | None = None

    @property
    def capabilities(self) -> SandboxCapabilities:
        return SandboxCapabilities(managed_launch=True, screen=False, recording=False)

    def prepare_for_launch(
        self,
        *,
        agent_name: str | None = None,
        labels: Mapping[str, str] | None = None,
        previous_sandbox_id: str | None = None,
    ) -> None:
        """
        Resolve this launch's person from session labels, or a relaunch's prior sandbox id.

        :param agent_name: Unused.
        :param labels: The launching session's labels, or ``None``.
        :param previous_sandbox_id: The host's previous :meth:`provision` value on a relaunch.
        """
        del agent_name
        found = labels or {}
        key = (
            found.get(LABEL_COMPUTER_KEY)
            or found.get(LABEL_COMPUTER_OWNER)
            or found.get(_DEPRECATED_LABEL_COMPUTER_KEY)
            or found.get(_DEPRECATED_LABEL_COMPUTER_OWNER)
        )
        tenant = tenant_from_labels(found)
        if key and tenant:
            self._key, self._tenant = key, tenant
            return
        if previous_sandbox_id:
            self._key, self._tenant, _container_id = _parse_sandbox_id(previous_sandbox_id)

    def prepare(self) -> None:
        if not os.path.exists(self._socket_path) and self._injected_client is None:
            raise click.ClickException(
                f"no Docker socket at {self._socket_path} — the 'computer' provider starts each "
                f"person's runner with Docker (set {DOCKER_SOCKET_ENV_VAR})"
            )
        if not self._key or not self._tenant:
            raise click.ClickException(
                "the 'computer' sandbox provider could not resolve this computer's identity — the "
                f"launching session must carry '{LABEL_COMPUTER_KEY}' "
                f"(or '{LABEL_COMPUTER_OWNER}') and '{LABEL_TENANT}' labels"
            )

    def _client(self) -> httpx.Client:
        if self._injected_client is None:
            self._injected_client = httpx.Client(
                transport=httpx.HTTPTransport(uds=self._socket_path), base_url="http://docker"
            )
        return self._injected_client

    def _docker(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        kwargs.setdefault("timeout", _REQUEST_TIMEOUT_S)
        try:
            return self._client().request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise click.ClickException(f"Docker request failed ({method} {path}): {exc}") from exc

    @staticmethod
    def _detail(response: httpx.Response) -> str:
        try:
            return response.text[:_MAX_ERROR_BODY_CHARS]
        except Exception:
            # Best-effort error text for an exception message; never worth failing over.
            return ""

    def _fail(self, what: str, response: httpx.Response) -> click.ClickException:
        return click.ClickException(f"{what} ({response.status_code}): {self._detail(response)}")

    def _image_id(self) -> str:
        response = self._docker("GET", f"/images/{quote(self._image, safe='')}/json")
        if response.status_code == 404:
            raise click.ClickException(
                f"runner image {self._image} is not on this Docker host — build it first "
                f"(see the README's Run with Docker) or set {IMAGE_ENV_VAR}"
            )
        if response.status_code >= 400:
            raise self._fail("could not inspect the runner image", response)
        return str(response.json().get("Id", ""))

    def _create_body(self, key: str, tenant: str) -> dict[str, Any]:
        return {
            "Image": self._image,
            "User": _COMPUTER_USER,
            "Env": list(_COMPUTER_ENV),
            "WorkingDir": _COMPUTER_HOME,
            "Labels": {
                _MANAGED_LABEL: "true",
                LABEL_COMPUTER_KEY: key,
                LABEL_TENANT: tenant,
            },
            "HostConfig": {
                "Mounts": [
                    {
                        "Type": "volume",
                        "Source": home_volume_name(key),
                        "Target": _COMPUTER_HOME,
                    }
                ],
                "ShmSize": _SHM_SIZE_BYTES,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "Memory": _memory_bytes(self._memory),
                "NanoCpus": _nano_cpus(self._cpus),
                "PidsLimit": self._pids_limit,
                "NetworkMode": self._network,
                # The runner dials the engine back at its public URL; native Linux needs this.
                "ExtraHosts": ["host.docker.internal:host-gateway"],
                "RestartPolicy": {"Name": "unless-stopped"},
            },
        }

    def _ensure_container_id(self, key: str, tenant: str) -> str:
        """Return the id of *key*'s running Computer, creating or recreating it as needed."""
        name = container_name(key)
        image_id = self._image_id()
        response = self._docker("GET", f"/containers/{name}/json")
        if response.status_code == 200:
            info = response.json()
            if info.get("Image") == image_id:
                if not (info.get("State") or {}).get("Running"):
                    self._start(str(info["Id"]))
                return str(info["Id"])
            # A new runner image: replace the container; the home volume stays.
            removed = self._docker("DELETE", f"/containers/{info['Id']}", params={"force": "true"})
            if removed.status_code >= 400 and removed.status_code != 404:
                raise self._fail("could not replace the Computer", removed)
        elif response.status_code != 404:
            raise self._fail("could not inspect the Computer", response)
        created = self._docker(
            "POST",
            "/containers/create",
            params={"name": name},
            json=self._create_body(key, tenant),
            timeout=_PROVISION_TIMEOUT_S,
        )
        if created.status_code == 409:
            # Another launch created it first; use that one.
            again = self._docker("GET", f"/containers/{name}/json")
            if again.status_code >= 400:
                raise self._fail("could not inspect the Computer", again)
            container_id = str(again.json()["Id"])
        elif created.status_code >= 400:
            raise self._fail("could not create the Computer", created)
        else:
            container_id = str(created.json()["Id"])
        self._start(container_id)
        return container_id

    def _start(self, container_id: str) -> None:
        response = self._docker("POST", f"/containers/{container_id}/start")
        if response.status_code not in (204, 304):
            raise self._fail("could not start the Computer", response)

    def provision(self, name: str) -> str:
        """
        Ensure this person's Computer is running and return its encoded sandbox id.

        :param name: Unused — Computers are keyed by person, not by the launch label.
        """
        del name
        if not self._key or not self._tenant:
            # prepare() already enforces this; guards type narrowing below.
            raise click.ClickException("the 'computer' sandbox provider has no identity")
        container_id = self._ensure_container_id(self._key, self._tenant)
        return f"{self._key}:{self._tenant}:{container_id}"

    def _live_container_id(self, sandbox_id: str) -> str:
        """The sandbox id's container, or the person's current one if it was recreated."""
        key, tenant, container_id = _parse_sandbox_id(sandbox_id)
        response = self._docker("GET", f"/containers/{quote(container_id, safe='')}/json")
        if response.status_code == 200 and (response.json().get("State") or {}).get("Running"):
            return container_id
        return self._ensure_container_id(key, tenant)

    def run(
        self,
        sandbox_id: str,
        command: str,
        *,
        check: bool = True,
        env: Mapping[str, str] | None = None,
    ) -> RemoteCommandResult:
        container_id = self._live_container_id(sandbox_id)
        body: dict[str, Any] = {
            "Cmd": ["sh", "-c", command],
            "AttachStdout": True,
            "AttachStderr": True,
            "WorkingDir": _COMPUTER_HOME,
        }
        if env:
            # Passed as exec environment, never in `command`: values stay out of argv and ps.
            body["Env"] = [f"{k}={v}" for k, v in env.items()]
        created = self._docker("POST", f"/containers/{container_id}/exec", json=body)
        if created.status_code >= 400:
            result = RemoteCommandResult(
                returncode=1, stdout="", stderr=f"exec failed: {self._detail(created)}"
            )
        else:
            exec_id = str(created.json()["Id"])
            started = self._docker(
                "POST",
                f"/exec/{exec_id}/start",
                json={"Detach": False, "Tty": False},
                timeout=_EXEC_TIMEOUT_S,
            )
            stdout, stderr = _demux(started.content)
            inspected = self._docker("GET", f"/exec/{exec_id}/json")
            code = inspected.json().get("ExitCode") if inspected.status_code == 200 else None
            result = RemoteCommandResult(
                returncode=int(code) if isinstance(code, int) else 1,
                stdout=stdout,
                stderr=stderr,
            )
        if check and result.returncode != 0:
            raise click.ClickException(
                f"command failed in the Computer (exit {result.returncode}): "
                f"{(result.stderr or result.stdout).strip()}"
            )
        return result

    def is_running(self, sandbox_id: str) -> bool | None:
        """Whether the sandbox id's container is running; ``None`` when Docker can't say."""
        try:
            _key, _tenant, container_id = _parse_sandbox_id(sandbox_id)
            response = self._docker("GET", f"/containers/{quote(container_id, safe='')}/json")
        except click.ClickException:
            return None
        if response.status_code == 404:
            return False
        if response.status_code >= 400:
            return None
        return bool((response.json().get("State") or {}).get("Running"))

    def is_host_supervisor_running(self, sandbox_id: str, host_id: str) -> bool:
        """
        Whether the supervised host loop for *host_id* is alive in the Computer.

        Stricter than the base check: the home volume keeps the pidfile across a container
        recreate while pids restart, so a pid counts only when it answers ``kill -0`` AND its
        ``/proc/<pid>/cmdline`` carries this host's pidfile path.

        :param sandbox_id: Target Computer.
        :param host_id: Host id of a prior launch; server-generated, validated here anyway.
        :returns: ``True`` iff the recorded pid is alive and is this host's supervise loop.
        """
        if not host_id.replace("-", "").replace("_", "").isalnum():
            return False
        pidfile = supervised_host_pidfile_path(host_id)
        marker = f"hosts/{host_id}.pid"
        check = (
            f"pid=$(cat {pidfile} 2>/dev/null); "
            'case "$pid" in ""|*[!0-9]*) exit 1;; esac; '
            'kill -0 "$pid" 2>/dev/null || exit 1; '
            f"tr '\\0' ' ' < \"/proc/$pid/cmdline\" 2>/dev/null | grep -qF -- '{marker}'"
        )
        return self.run(sandbox_id, check, check=False).returncode == 0
