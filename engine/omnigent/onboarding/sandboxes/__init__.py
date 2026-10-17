"""Sandbox launchers: run Omnigent hosts in remote sandboxes.

The server's managed-host code launches hosts through these. Core Omnigent
contributes the built-in ``computer`` provider directly; third-party packages
can contribute providers through the ``omnigent.sandbox_providers`` entry
point group.
"""

from __future__ import annotations

import click

from omnigent.onboarding.sandboxes.base import (
    RemoteCommandResult,
    RemoteProcess,
    SandboxCapabilityError,
    SandboxGoneError,
    SandboxHostLauncher,
    SandboxLauncher,
)
from omnigent.onboarding.sandboxes.registry import (
    COMMUNITY_MODULE_PREFIX,
    SandboxProviderContribution,
    SandboxProviderMetadata,
    SandboxProviderPluginState,
    SandboxRegistryError,
    available_providers,
    get_provider_metadata,
    instantiate,
    plugin_state,
    reset_plugin_state_for_tests,
)
from omnigent.onboarding.sandboxes.types import (
    GitCloneOptions,
    HostContext,
    RepoWorkspace,
    SandboxCapabilities,
    SandboxCommandError,
    SandboxConfigError,
    SandboxError,
    SandboxInfo,
    SandboxSpec,
)

__all__ = [
    "COMMUNITY_MODULE_PREFIX",
    "GitCloneOptions",
    "HostContext",
    "RemoteCommandResult",
    "RemoteProcess",
    "RepoWorkspace",
    "SandboxCapabilities",
    "SandboxCapabilityError",
    "SandboxCommandError",
    "SandboxConfigError",
    "SandboxError",
    "SandboxGoneError",
    "SandboxHostLauncher",
    "SandboxInfo",
    "SandboxLauncher",
    "SandboxProviderContribution",
    "SandboxProviderMetadata",
    "SandboxProviderPluginState",
    "SandboxRegistryError",
    "SandboxSpec",
    "available_providers",
    "get_launcher",
    "get_provider_metadata",
    "plugin_state",
    "reset_plugin_state_for_tests",
]


def get_launcher(provider: str) -> SandboxHostLauncher:
    """
    Resolve a provider name to a launcher instance.

    :param provider: Provider name, e.g. ``"computer"``.
    :returns: A fresh launcher for the provider.
    :raises click.ClickException: If the provider is unknown or its
        launcher module is not present in this build.
    """
    if provider not in plugin_state():
        offered = ", ".join(available_providers()) or "(none in this build)"
        raise click.ClickException(
            f"Unknown or unavailable sandbox provider '{provider}'. Available: {offered}."
        )
    try:
        return instantiate(provider)
    except SandboxRegistryError as exc:
        raise click.ClickException(str(exc)) from exc
