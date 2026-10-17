"""Interactive harness & credential configuration for the CLI.

Everything behind ``omnigent config`` / ``omnigent setup`` and the first-run
``configure harnesses`` picker: detecting installed provider CLIs, prompting for
API keys, installing SDK harnesses, and writing the results to global config.
Extracted from :mod:`omnigent.cli` to keep that module under the repo's
per-file size budget; the ``config`` / ``setup`` Click commands stay in
``omnigent.cli`` and reach these helpers via :func:`register`.

The three config-load helpers these functions need (``_load_global_config``,
``_save_global_config``, ``_load_effective_config``) live in ``omnigent.cli`` and
are used ~20x each there, so they stay put; this module reaches them through
call-time proxies below, so importing this module never imports ``omnigent.cli``
(no cycle) and a test's ``monkeypatch`` of ``omnigent.cli.<helper>`` is still
honoured.
"""

from __future__ import annotations

import collections.abc
import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import click

from omnigent.inner import ui
from omnigent.util.tmux_compat import MIN_TMUX_VERSION, MIN_TMUX_VERSION_HINT, tmux_version

if TYPE_CHECKING:
    from omnigent._runner_startup import RunnerStartupProgress
    from omnigent.onboarding.ambient import DetectedProvider
    from omnigent.onboarding.provider_config import ProviderEntry

# Brand shown for an auto-configured CLI login in the credentials callout —
# the product the login authenticates, not the CLI name (the codex CLI logs in
# a ChatGPT subscription). Keyed by the ambient detection name; these are the
# only two subscription CLIs ambient detection emits.
_CLI_LOGIN_BRAND: dict[str, str] = {"claude": "Claude", "codex": "ChatGPT"}


def _load_global_config() -> dict[str, Any]:  # type: ignore[explicit-any]
    import omnigent.cli as _cli

    return _cli._load_global_config()


def _save_global_config(  # type: ignore[explicit-any]
    settings: collections.abc.Mapping[str, Any],
    unset_keys: tuple[str, ...] = (),
    deep_merge_keys: tuple[str, ...] = (),
) -> None:
    import omnigent.cli as _cli

    _cli._save_global_config(settings, unset_keys, deep_merge_keys)


def _load_effective_config() -> dict[str, Any]:  # type: ignore[explicit-any]
    import omnigent.cli as _cli

    return _cli._load_effective_config()


# Node version hint shared by the preflight problem messages and surfaced
# to the user. The Node-based harness CLIs (Claude Code, Codex, Pi) bundle
# a copy of ``undici`` that calls ``worker_threads.markAsUncloneable`` — a
# Node API added in 22.10 that is absent from every 20.x release. On older
# Node it surfaces as the opaque
# ``TypeError: webidl.util.markAsUncloneable is not a function``.
_NODE_MIN_VERSION_HINT = "Node.js 22 LTS or newer (a 22.10+ API is required)"


def _node_version(node_path: str) -> str | None:
    """
    Return the ``node --version`` string (e.g. ``v20.12.2``) or ``None``.

    Used only to make the "too old" warning concrete; a failure to read the
    version is non-fatal — the caller still reports the underlying problem.

    :param node_path: Absolute path to the ``node`` binary, as resolved by
        :func:`shutil.which`.
    :returns: The trimmed version string, or ``None`` if ``node`` could not
        be invoked.
    """
    try:
        result = subprocess.run(
            [node_path, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def _node_dependency_problem() -> str | None:
    """
    Return a one-line problem if Node is missing or too old, else ``None``.

    The Node-based harnesses (``claude-native``, ``codex``, ``pi``) shell
    out to CLIs that bundle ``undici``; that bundle calls
    ``worker_threads.markAsUncloneable`` (added in Node 22.10). We invoke
    ``node`` to probe for the symbol directly rather than parse
    ``node --version``, so the check tracks the actual capability across
    the 22.x/23.x version split and never goes stale against a hardcoded
    floor.

    :returns: A human-readable description suitable for a warning bullet,
        or ``None`` when Node is present and new enough. A flaky/timed-out
        probe also yields ``None`` — setup should not block on it.
    """
    node = shutil.which("node")
    if node is None:
        return f"node not found — Claude, Codex, and Pi need {_NODE_MIN_VERSION_HINT}."
    # Probe the exact API the bundled undici calls. Exit 0 ⇒ capability
    # present; exit 1 ⇒ too old; we treat any other failure as inconclusive.
    probe = (
        "process.exit("
        "typeof require('node:worker_threads').markAsUncloneable === 'function' ? 0 : 1)"
    )
    try:
        result = subprocess.run(
            [node, "-e", probe],
            capture_output=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        return None
    version = _node_version(node)
    detected = f" (detected {version})" if version else ""
    return f"Node.js is too old{detected} — Claude, Codex, and Pi need {_NODE_MIN_VERSION_HINT}."


def _tmux_dependency_problem() -> str | None:
    """
    Return a one-line problem if tmux is missing or too old, else ``None``.

    The native tmux-backed harnesses (claude-native / codex-native and
    every managed terminal) need a tmux at or above
    :data:`omnigent.util.tmux_compat.MIN_TMUX_VERSION`. Managed terminals enable
    ``allow-passthrough``, which tmux added in 3.3. Parses ``tmux -V`` (e.g.
    ``"tmux 3.3a"`` — suffix letters are ignored) and compares the
    ``(major, minor)`` pair against the floor.

    :returns: A human-readable description suitable for a warning bullet,
        or ``None`` when tmux is present and new enough. A flaky/timed-out
        probe or unparsable version also yields ``None`` — setup should
        not block on it.
    """
    tmux = shutil.which("tmux")
    if tmux is None:
        return "tmux not found — native Claude/Codex need tmux (macOS: `brew install tmux`)."
    version = tmux_version(tmux)
    if version is None or version >= MIN_TMUX_VERSION:
        return None
    detected = f"{version[0]}.{version[1]}"
    return (
        f"tmux is too old (detected tmux {detected}) — native Claude/Codex need "
        f"tmux {MIN_TMUX_VERSION_HINT} or newer (macOS: `brew upgrade tmux`)."
    )


def _warn_missing_harness_dependencies() -> None:
    """
    Warn about external (non-Python) tools the coding harnesses need.

    Surfaces every missing/outdated dependency up front (when the user
    opens ``configure harnesses``) so a fresh machine learns about all of
    them at once, rather than discovering each at the moment a harness or
    wrapper needs it (Node when a harness CLI runs, tmux when a native
    terminal launches). This *warns* rather than aborts on purpose: the
    pure-Python SDK harnesses run without either tool, so a hard failure
    would block a valid flow — but the native terminals do need both, hence
    the prominent notice.

    :returns: None. Side effect: writes a yellow warning block to stderr
        via :mod:`omnigent.inner.ui` when one or more dependencies are
        missing.
    """
    problems: list[str] = []
    node_problem = _node_dependency_problem()
    if node_problem is not None:
        problems.append(node_problem)
    tmux_problem = _tmux_dependency_problem()
    if tmux_problem is not None:
        problems.append(tmux_problem)
    if not problems:
        return
    ui.warn("Some harnesses need external tools:")
    for problem in problems:
        ui.err_console.print(f"  • {problem}", style="omni.warning", markup=False)
    ui.err_console.print(
        "You can configure credentials now; install these before launching those harnesses.",
        style="omni.warning",
        markup=False,
    )


def _print_credentials_by_harness() -> None:
    """Print configured model credentials grouped by harness (the ``config list`` view).

    Renders the effective config **merged with ambient detections** (a
    detected env key / CLI login shows as an ordinary credential, with no
    separate "detected vs configured" split) grouped under each harness
    family, with the per-family default marked — via
    :func:`render_provider_listing_by_harness`.

    :returns: None. Side effect: writes the listing to the onboarding
        console.
    """
    from omnigent.onboarding.configure_models import render_provider_listing_by_harness
    from omnigent.onboarding.detected import effective_config_with_detected
    from omnigent.onboarding.provider_config import load_providers

    config = effective_config_with_detected(_load_effective_config())
    providers = load_providers(config)
    render_provider_listing_by_harness(config, providers)


def _existing_key_name_for_ref(  # type: ignore[explicit-any]  # config is a yaml-boundary mapping
    config: dict[str, Any],
    family: str,
    api_key_ref: str,
) -> str | None:
    """Return the name of a ``key`` provider on *family* using *api_key_ref*.

    Two API keys are "the same key" when they read the same secret source
    (the same ``env:`` / ``keychain:`` reference). The add flow uses this to
    update such a key in place rather than writing a second, identical entry —
    so re-adding a key you already have stays idempotent, while a key from a
    genuinely different source gets its own entry (the "keep both" behavior).

    :param config: The parsed global config mapping (``providers:`` block).
    :param family: The harness family the key serves, ``"anthropic"`` or
        ``"openai"``.
    :param api_key_ref: The secret reference to match, e.g.
        ``"env:ANTHROPIC_API_KEY"`` or ``"keychain:anthropic"``.
    :returns: The provider name whose *family* block references the same
        secret, e.g. ``"anthropic"``, or ``None`` when no such key exists.
    """
    from omnigent.onboarding.provider_config import KEY_KIND, load_providers

    for name, entry in load_providers(config).items():
        if entry.kind != KEY_KIND:
            continue
        fam = entry.families.get(family)
        if fam is not None and fam.api_key_ref == api_key_ref:
            return name
    return None


def _unique_provider_name(  # type: ignore[explicit-any]  # config is a yaml-boundary mapping
    config: dict[str, Any],
    candidate: str,
) -> str:
    """Return *candidate*, suffixed numerically until it's a free provider name.

    Provider names key the ``providers:`` mapping, so a colliding name would
    overwrite an existing entry on deep-merge. When the add flow keeps a
    second credential (an API key from a new source for a vendor that already
    has one), this derives a fresh name — ``anthropic`` → ``anthropic-2`` →
    ``anthropic-3`` — so both coexist.

    :param config: The parsed global config mapping (``providers:`` block).
    :param candidate: The preferred name, e.g. ``"anthropic"``.
    :returns: *candidate* if unused, else the first free ``<candidate>-<n>``
        (``n`` starting at 2), e.g. ``"anthropic-2"``.
    """
    from omnigent.onboarding.provider_config import load_providers

    existing = set(load_providers(config))
    if candidate not in existing:
        return candidate
    n = 2
    while f"{candidate}-{n}" in existing:
        n += 1
    return f"{candidate}-{n}"


def _resolve_key_provider_name(  # type: ignore[explicit-any]  # config is a yaml-boundary mapping
    config: dict[str, Any],
    family: str,
    candidate: str,
    api_key_ref: str,
) -> str:
    """Pick the entry name for an API key being added — update vs keep-both.

    Realizes the "allow multiple API keys, keep both if source differs"
    behavior: a key whose secret source (*api_key_ref*) matches an existing
    key on *family* reuses that entry's name (an in-place update of the same
    credential); a key from a new source takes a fresh, unique name so it
    coexists with the others.

    :param config: The parsed global config mapping (``providers:`` block).
    :param family: The harness family the key serves, ``"anthropic"`` or
        ``"openai"``.
    :param candidate: The preferred name (the vendor id for a preset, or the
        user-typed name for "Other provider"), e.g. ``"anthropic"``.
    :param api_key_ref: The key's secret reference, e.g.
        ``"env:ANTHROPIC_API_KEY"`` or ``"keychain:anthropic"``.
    :returns: The existing same-source entry's name (update in place), else a
        unique name derived from *candidate* (keep both), e.g.
        ``"anthropic-2"``.
    """
    same_source = _existing_key_name_for_ref(config, family, api_key_ref)
    if same_source is not None:
        return same_source
    return _unique_provider_name(config, candidate)


def _credential_source_hint(entry: ProviderEntry, family: str) -> str | None:
    """A short, non-secret descriptor of where a key's secret comes from.

    Used to disambiguate two API keys that would otherwise share a label
    (e.g. two "Anthropic API Key" rows): an ``env:`` ref renders as
    ``$VAR``, a ``keychain:`` ref as its stored name, an inline ``$VAR`` as
    itself. Only meaningful for credential kinds that carry an inline family
    block (``key`` / ``gateway`` / ``local``).

    :param entry: The parsed provider entry.
    :param family: The surface whose secret source to describe,
        ``"anthropic"``, ``"openai"``, or ``"pi"``.
    :returns: A display hint such as ``"$ANTHROPIC_API_KEY"`` or
        ``"anthropic-2"``, or ``None`` when the family has no resolvable
        source descriptor.
    """
    from omnigent.onboarding.provider_config import (
        ANTHROPIC_FAMILY,
        OPENAI_FAMILY,
        PI_SURFACE,
    )

    raw = entry.families.get(family)
    if raw is None and family == PI_SURFACE:
        # The pi surface carries no family block of its own — pi consumes
        # the credential of whichever family it routes through (anthropic
        # preferred), so describe that family's source instead.
        for fam in (ANTHROPIC_FAMILY, OPENAI_FAMILY):
            raw = entry.families.get(fam)
            if raw is not None:
                break
    if raw is None:
        return None
    if raw.api_key_ref is not None:
        if raw.api_key_ref.startswith("env:"):
            return f"${raw.api_key_ref[len('env:') :]}"
        if raw.api_key_ref.startswith("keychain:"):
            return raw.api_key_ref[len("keychain:") :]
    if raw.api_key is not None and raw.api_key.startswith("$"):
        return raw.api_key
    return None


def _family_key_count(  # type: ignore[explicit-any]  # config is a yaml-boundary mapping
    config: dict[str, Any],
    family: str,
) -> int:
    """Count the ``key`` providers serving *family*.

    The ``($VAR)`` disambiguation hint is shown only when more than one API
    key serves a harness — a lone key needs no source qualifier.

    :param config: The parsed global config mapping (``providers:`` block).
    :param family: The harness family, ``"anthropic"`` or ``"openai"``.
    :returns: The number of ``kind: key`` providers serving *family*.
    """
    from omnigent.onboarding.provider_config import (
        KEY_KIND,
        load_providers,
        provider_families,
    )

    return sum(
        1
        for entry in load_providers(config).values()
        if entry.kind == KEY_KIND and family in provider_families(entry)
    )


def _family_credential_label(  # type: ignore[explicit-any]  # config is a yaml-boundary mapping
    config: dict[str, Any],
    family: str,
    name: str,
    entry: ProviderEntry,
) -> str:
    """A credential label, qualified with its source when keys would collide.

    Wraps :func:`_credential_label`, appending the ``($VAR)`` source hint for
    a ``key`` provider when more than one API key serves *family* (so two
    "Anthropic API Key" rows read as distinct). Non-key kinds and the
    single-key case render the plain label.

    :param config: The parsed global config mapping (``providers:`` block).
    :param family: The harness family in context, ``"anthropic"`` /
        ``"openai"``.
    :param name: The provider id keyed under ``providers:``, e.g.
        ``"anthropic-2"``.
    :param entry: The parsed provider entry.
    :returns: A human label, e.g. ``"Anthropic API Key ($ANTHROPIC_API_KEY)"``
        when disambiguation applies, else ``"Anthropic API Key"``.
    """
    from omnigent.onboarding.provider_config import KEY_KIND

    base = _credential_label(name, entry)
    if entry.kind != KEY_KIND or _family_key_count(config, family) <= 1:
        return base
    hint = _credential_source_hint(entry, family)
    return f"{base} ({hint})" if hint else base


def _configure_harness_add(family: str | None = None) -> str | None:
    """Run the interactive ``add a provider`` flow and persist the entry.

    Prompts for the provider kind (key / subscription / gateway /
    bedrock), gathers the kind-specific fields, deep-merges the single
    entry under ``providers:`` (an add never rewrites siblings), and makes
    it the default for any family it serves that has **no** default yet
    (so a first provider just works; an existing default is left for the
    user to change by selecting it in the harness tree).

    :param family: When set (``"anthropic"`` / ``"openai"`` / ``"pi"``),
        the add menu is scoped to credentials that can drive that harness —
        the per-harness "Add a provider" path. ``None`` shows the full menu.
    :returns: A confirmation message for the caller to show as a transient
        status. Side effect: writes to ``~/.omnigent/config.yaml`` and,
        for a pasted API key, the secret store.
    """
    from omnigent.onboarding import secrets as secret_store
    from omnigent.onboarding.ambient import detect_providers
    from omnigent.onboarding.configure_models import (
        AddOption,
        add_menu_options,
        add_menu_options_for_family,
        build_bedrock_provider_entry,
        build_cli_config_provider_entry,
        build_gateway_provider_entry,
        build_key_provider_entry,
        build_subscription_provider_entry,
        default_base_url_for_family,
        family_for_key_provider,
        key_provider_endpoint,
        other_key_providers,
        provider_display_name,
    )
    from omnigent.onboarding.interactive import console, prompt_text, select
    from omnigent.onboarding.provider_config import (
        ANTHROPIC_FAMILY,
        CHAT_WIRE_API,
        CLI_CONFIG_KIND,
        OPENAI_FAMILY,
        RESPONSES_WIRE_API,
        SUBSCRIPTION_KIND,
        load_providers,
        provider_entry_settings,
        set_default_provider,
    )

    # A flat, credential-aware menu: the user picks "OpenAI — API key" or
    # "Claude — subscription" directly (rather than a bare kind then
    # provider two-step). Each option carries the resolved kind and, for
    # the common cases, a preset provider/cli. When entered from a specific
    # harness, the menu is scoped to that harness's surface.
    options = add_menu_options_for_family(family) if family is not None else add_menu_options()
    # A custom provider defined by the user's own ~/.codex/config.toml
    # (e.g. a company AI gateway) that is not currently configured
    # gets its own add option. This is the only way back after Remove —
    # removal dismisses the detection so it stops auto-adopting, and there
    # is nothing to type/paste here (the credential lives in that file).
    cli_config_dets: list[DetectedProvider] = []
    if family in (None, OPENAI_FAMILY):
        configured_names = set(load_providers(_load_global_config()))
        cli_config_dets = [
            d
            for d in detect_providers()
            if d.kind == CLI_CONFIG_KIND and d.name not in configured_names
        ]
    # Base options first, then one row per detected config provider — the
    # selection index maps back into cli_config_dets below.
    base_option_count = len(options)
    options = options + [
        AddOption(
            label=f"\N{GEAR}\N{VARIATION SELECTOR-16} {d.display_name or d.name} — "
            "from your Codex config",
            description=(
                f"Use the {str(d.model_provider)!r} provider your ~/.codex/config.toml "
                "defines and authenticates."
            ),
            kind=CLI_CONFIG_KIND,
        )
        for d in cli_config_dets
    ]
    choice = select(
        "What do you want to add?",
        [o.label for o in options],
        descriptions=[o.description for o in options],
        clear_on_exit=True,
    )
    if choice < 0:  # Esc — abort the add
        return None
    chosen = options[choice]
    kind = chosen.kind

    name: str
    # Any (not object): this entry is handed to provider_entry_settings /
    # set_default_provider, which type their config mappings as object;
    # _ConfigValue would trip dict invariance against those. Matches the
    # cli.py yaml-boundary convention.
    entry: dict[str, Any]  # type: ignore[explicit-any]

    if kind == CLI_CONFIG_KIND:
        # One detected-config row was appended per cli_config_dets entry, in
        # order, after the base options — map the selection back to its
        # detection. Nothing to prompt for: the provider definition AND its
        # credential live in ~/.codex/config.toml; the entry only pins it.
        det = cli_config_dets[choice - base_option_count]
        if det.model_provider is None:  # always set on cli-config detections
            raise click.ClickException("internal: cli-config detection missing model_provider")
        name = det.name
        entry = build_cli_config_provider_entry("codex", det.model_provider, det.display_name)
        # Re-adding is the user saying "I want this auto-detected credential
        # after all" — drop any standing dismissal so it behaves like an
        # ordinary detection again (e.g. re-adopts after a config self-heal).
        _clear_detection_dismissal(name)

    elif kind == "key":
        if chosen.provider is not None:
            provider = chosen.provider  # preset by the flat option (OpenAI/Anthropic/OpenRouter)
            # Preset: the preferred name is the provider id — but the final name
            # is resolved from the key's source below (update in place vs keep
            # both), so a second key for the same vendor doesn't overwrite the
            # first.
            candidate = provider
        else:
            # "Other provider — API key": pick from the remaining catalog,
            # shown by friendly display name. This is the one key case where a
            # custom name is useful (e.g. two configs for the same vendor), so
            # it's the only non-gateway path that still prompts for a name.
            others = other_key_providers()
            if not others:  # ponytail: every catalog key-provider is already a preset/configured
                click.echo("No other API-key providers left to add.")
                return None
            _other_choice = select(
                "Which provider?",
                [provider_display_name(p) for p in others],
                clear_on_exit=True,
            )
            if _other_choice < 0:  # Esc — abort the add
                return None
            provider = others[_other_choice]
            candidate = prompt_text("Name for this provider", default=provider)
        disp = provider_display_name(provider)
        family = family_for_key_provider(provider)
        # The entry name is resolved from the key's source (not just the
        # candidate): a key whose source matches an existing one updates it in
        # place, while a key from a new source takes a fresh name so both
        # coexist ("allow multiple API keys"). See _resolve_key_provider_name.
        config_now = _load_global_config()
        # Offer to reuse a detected env var for this provider rather than
        # forcing the user to re-paste a key they already have in the env.
        detected = {d.name: d for d in detect_providers()}
        api_key_ref: str
        if (
            provider in detected
            and detected[provider].kind == "key"
            and click.confirm(
                f"Detected {detected[provider].source} in the environment — use it?",
                default=True,
            )
        ):
            env_var = detected[provider].source.lstrip("$")  # e.g. "ANTHROPIC_API_KEY"
            api_key_ref = f"env:{env_var}"
            name = _resolve_key_provider_name(config_now, family, candidate, api_key_ref)
        else:
            # A pasted key is stored at keychain:<name>; resolve the name first
            # (an existing key in this same keychain slot is replaced in place,
            # otherwise we pick a free name) so we store under and reference the
            # final name.
            name = _resolve_key_provider_name(
                config_now, family, candidate, f"keychain:{candidate}"
            )
            pasted = prompt_text(f"{disp} API key", hide_input=True)
            secret_store.store_secret(name, pasted)
            api_key_ref = f"keychain:{name}"

        # Default model — free-form text entry. The bundled catalog lags new
        # releases (e.g. a brand-new claude-sonnet-4-6 won't be listed yet), so
        # a fixed picker would block the user from a model they can actually
        # use. Pre-fill the canonical default and let the user type ANY model
        # id. Blank accepts a known catalog default; without one, the prompt
        # requires an explicit model id.
        from omnigent.onboarding.providers import default_chat_model

        catalog_default = default_chat_model(provider)
        # default=catalog_default (str | None): a known provider pre-fills its
        # default (blank-enter accepts it); an unknown provider has no default,
        # so the user types a model id. ``.strip() or None`` keeps an
        # all-whitespace entry from becoming a bogus pin.
        typed = prompt_text("Default model", default=catalog_default)
        default_model = typed.strip() or None

        # A third-party OpenAI-compatible vendor (OpenRouter, Groq, …) is
        # reached at its OWN base_url and speaks Chat Completions; openai /
        # anthropic use the canonical family endpoint (and openai keeps the
        # Responses default). Using the family default for a vendor sent its
        # traffic to api.openai.com — the reason an OpenRouter key failed.
        endpoint = key_provider_endpoint(provider)
        if endpoint is not None:
            base_url = endpoint.base_url
            key_wire_api: str | None = endpoint.wire_api
        else:
            base_url = default_base_url_for_family(family)
            key_wire_api = None
        entry = build_key_provider_entry(
            family=family,
            base_url=base_url,
            api_key_ref=api_key_ref,
            default_model=default_model,
            wire_api=key_wire_api,
        )

    elif kind == "subscription":
        cli_name = chosen.cli  # preset by the flat option (claude / codex / pi)
        if cli_name is None:
            raise click.ClickException("internal: subscription option missing a cli login")
        from omnigent.onboarding.configure_models import cli_display_name

        # A harness has at most ONE subscription. If one is already configured
        # for this CLI (under any name), offer to replace it — declining aborts
        # before we touch any login.
        existing_subs = [
            n
            for n, e in load_providers(_load_global_config()).items()
            if e.kind == SUBSCRIPTION_KIND and e.cli == cli_name
        ]
        if existing_subs:
            replace = select(
                f"A {cli_display_name(cli_name)} subscription is already configured. Replace it?",
                ["Replace it", "Keep the current one"],
                default=0,
                clear_on_exit=True,
            )
            if replace != 0:  # "Keep the current one" or Esc — abort the add
                return None
        # CLIs listed in _CLI_LOGIN_BRAND (claude / codex) require a login step.
        # CLIs not listed (pi) manage their own auth — no login step needed.
        if cli_name in _CLI_LOGIN_BRAND:
            from omnigent.onboarding.harness_install import harness_install_spec, harness_login

            login_family = {"claude": ANTHROPIC_FAMILY, "codex": OPENAI_FAMILY}.get(cli_name)
            if login_family is None:
                raise click.ClickException(f"internal: no login family for cli {cli_name!r}")
            spec = harness_install_spec(login_family)
            disp = spec.display if spec is not None else cli_name
            # Configure is the single place to sign in: drive the harness's own
            # login (a no-op if already logged in). Only record the subscription
            # once the CLI is actually authenticated — otherwise we'd persist a
            # phantom subscription that strands the user at the harness's own login
            # screen at run time (the exact bug this whole flow fixes).
            console.print(f"  [dim]Signing in to {disp} (its login will open)…[/dim]")
            if not harness_login(login_family):
                return f"✗ {disp} login not completed — subscription not added"
        # Drop the existing subscription(s) now that we know we're proceeding.
        # Done after any login so a failed login leaves the existing entry intact.
        if existing_subs:
            block = _load_global_config().get("providers")
            if isinstance(block, dict):
                remaining = {k: v for k, v in block.items() if k not in existing_subs}
                _save_global_config({"providers": remaining})
        # Subscription name is derived from the CLI — no prompt.
        name = f"{cli_name}-subscription"
        entry = build_subscription_provider_entry(cli_name)

    elif kind == "gateway":
        name = prompt_text("Name for this gateway", default="gateway")
        base_url = prompt_text("Gateway base_url (OpenAI/Anthropic-compatible)")
        pasted = prompt_text("Gateway API key", hide_input=True)
        secret_store.store_secret(name, pasted)
        # Which harness surfaces — one clear pick instead of two y/n prompts.
        # (These are *harness* surfaces: Codex/OpenAI → codex;
        # Claude/Anthropic → claude-sdk + native-claude.)
        surface_choice = select(
            "Which harnesses can this gateway drive?",
            [
                "Both Claude and Codex",
                "Codex / OpenAI only",
                "Claude only (claude-sdk, native-claude)",
            ],
            default=0,
            clear_on_exit=True,
        )
        if surface_choice < 0:  # Esc — abort the add
            return None
        families = (
            [OPENAI_FAMILY, ANTHROPIC_FAMILY]
            if surface_choice == 0
            else [OPENAI_FAMILY]
            if surface_choice == 1
            else [ANTHROPIC_FAMILY]
        )
        # Wire protocol for the OpenAI surface: OpenAI / LiteLLM speak the
        # Responses API; OpenRouter and many OSS-model gateways are
        # Chat-Completions-only. Picking wrong makes every turn fail (the
        # exact "OpenRouter doesn't work but LiteLLM does" symptom), so ask —
        # defaulting to Chat when the URL looks like OpenRouter.
        wire_api: str | None = None
        if OPENAI_FAMILY in families:
            wire_choice = select(
                "OpenAI wire protocol for this gateway?",
                [
                    "Responses API (OpenAI, LiteLLM)",
                    "Chat Completions (OpenRouter, most OSS-model gateways)",
                ],
                default=1 if "openrouter" in base_url.lower() else 0,
                clear_on_exit=True,
            )
            if wire_choice < 0:  # Esc — abort the add
                return None
            wire_api = RESPONSES_WIRE_API if wire_choice == 0 else CHAT_WIRE_API
        # Default model per served surface. A gateway has NO catalog default,
        # so without a pin routing would fall back to a vendor model the
        # gateway can't serve. The OpenAI surface pre-fills the catalog's
        # preferred Kimi-family model; if none is advertised, the user must
        # type a gateway model id explicitly.
        from omnigent.onboarding.providers import default_chat_model

        models: dict[str, str] = {}
        if OPENAI_FAMILY in families:
            models[OPENAI_FAMILY] = prompt_text(
                "Default model for the Codex / OpenAI surface",
                default=default_chat_model("openrouter"),
            ).strip()
        if ANTHROPIC_FAMILY in families:
            models[ANTHROPIC_FAMILY] = prompt_text(
                "Default model for the Claude surface (the gateway's Claude model id)"
            ).strip()
        entry = build_gateway_provider_entry(
            base_url=base_url,
            api_key_ref=f"keychain:{name}",
            families=families,
            wire_api=wire_api,
            models=models,
        )

    else:  # bedrock
        # Bedrock drives the native Claude terminal in AWS Bedrock mode. It
        # authenticates from AWS_BEARER_TOKEN_BEDROCK in the env at launch
        # (Claude Code ignores apiKeyHelper once Bedrock mode is on), so offer
        # to reference an exported token, else store a pasted one in the keychain.
        name = prompt_text("Name for this Bedrock provider", default="bedrock")
        base_url = prompt_text(
            "Bedrock base_url (regional runtime endpoint, or your Bedrock-compatible gateway)",
            default="https://bedrock-runtime.us-east-1.amazonaws.com",
        )
        if os.environ.get("AWS_BEARER_TOKEN_BEDROCK") and click.confirm(
            "Detected AWS_BEARER_TOKEN_BEDROCK in the environment — use it?", default=True
        ):
            api_key_ref = "env:AWS_BEARER_TOKEN_BEDROCK"
        else:
            pasted = prompt_text("Amazon Bedrock API key (bearer token)", hide_input=True)
            secret_store.store_secret(name, pasted)
            api_key_ref = f"keychain:{name}"
        # Bedrock has no catalog default and Claude's own default model is
        # usually not enabled on a Bedrock account, so pin an explicit id.
        default_model = (
            prompt_text(
                "Default model (Bedrock inference-profile id or ARN; e.g. "
                "us.vendor.model-family-YYYYMMDD-v1:0)"
            ).strip()
            or None
        )
        family = ANTHROPIC_FAMILY
        entry = build_bedrock_provider_entry(
            base_url=base_url,
            api_key_ref=api_key_ref,
            default_model=default_model,
        )

    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.provider_config import (
        provider_families,
        surface_default_provider,
    )

    # Persist the entry (deep-merge — doesn't disturb sibling entries).
    _save_global_config(
        provider_entry_settings(name, entry, make_default=False),
        deep_merge_keys=("providers",),
    )
    # Become the default for any surface it serves that has NO default yet,
    # so a first provider "just works". An existing default is left alone —
    # the user changes defaults by selecting a provider in the harness tree
    # (per-surface, so a shared provider can default one harness, not both).
    # The pi surface checks its *effective* default: a family default already
    # drives pi via the fallback, so claiming the explicit pi scope then
    # would silently re-route pi away from it.
    parsed = load_providers({"providers": {name: entry}})[name]
    default_families = sorted(provider_families(parsed))
    became_default: list[str] = []
    for fam in default_families:
        cfg = _load_global_config()
        if surface_default_provider(cfg, fam) is not None:
            continue
        block = cfg.get("providers")
        if isinstance(block, dict):
            _save_global_config({"providers": set_default_provider(block, name, fam)})
            became_default.append(fam)
    if became_default:
        labels = " · ".join(family_label(f) for f in became_default)
        return f"✓ Added {name} — default for {labels}"
    return f"✓ Added {name}"


def _adopt_detected_providers() -> list[str]:
    """Persist ambient-detected providers into the config, returning new names.

    Opening ``configure harnesses`` adopts any detected credential (env key,
    CLI login, local Ollama) not already in ``providers:`` as a real,
    editable entry — so the tree shows one uniform provider list with no
    "detected vs configured" split. Writes the merged view (explicit +
    detected, with detected auto-defaulting per family) wholesale, and only
    when there is something new to adopt (idempotent on re-open).

    :returns: The names adopted this call, e.g. ``["anthropic", "codex"]``;
        empty when every detection is already configured.
    """
    from omnigent.onboarding.detected import (
        effective_config_with_detected,
        providers_to_adopt,
    )

    config = _load_global_config()
    to_adopt = providers_to_adopt(config)
    if not to_adopt:
        return []
    merged = effective_config_with_detected(config)
    _save_global_config({"providers": merged["providers"]})  # wholesale replace
    return list(to_adopt)


def _claude_managed_gateway_label() -> str | None:
    """Display label for a Claude credential backed by Claude Code's managed gateway.

    When Claude Code's own settings deliver a gateway credential (enterprise
    ``ANTHROPIC_BASE_URL`` + ``apiKeyHelper``), the Claude "subscription" the
    machine really carries is that gateway, so setup names it as such (e.g.
    ``"Databricks AI Gateway"``) instead of the generic ``"Subscription"``.
    Purely a display derivation from live managed settings — nothing persisted.

    :returns: The gateway label, or ``None`` when no managed credential is present.
    """
    from omnigent.onboarding.ambient import claude_managed_gateway_display_name

    return claude_managed_gateway_display_name()


def _compact_credential_label(det: DetectedProvider) -> str:
    """A short, brand-qualified label for an auto-configured credential.

    Unlike :func:`omnigent.onboarding.configure_models.credential_label`
    (which renders every CLI login as a bare ``"Subscription"`` because a
    harness only ever has one), this names the *brand* behind a login —
    ``"Claude Subscription"`` / ``"ChatGPT Subscription"`` — so a single
    comma-joined callout listing several credentials at once stays unambiguous
    without a per-line source. API keys and local endpoints reuse the shared
    ``credential_label`` (``"Anthropic API Key"``, ``"Ollama"``).

    :param det: A credential found by
        :func:`omnigent.onboarding.ambient.detect_providers`.
    :returns: A short human label, e.g. ``"Anthropic API Key"``,
        ``"Claude Subscription"``, or ``"ChatGPT Subscription"``.
    """
    from omnigent.onboarding.ambient import SUBSCRIPTION_KIND
    from omnigent.onboarding.configure_models import credential_label

    if det.kind == SUBSCRIPTION_KIND:
        # A Claude login whose real backing is Claude Code's managed-settings
        # gateway names that gateway, so the callout matches Codex-Databricks.
        if det.name == "claude":
            gateway = _claude_managed_gateway_label()
            if gateway is not None:
                return gateway
        # Fallback to the raw CLI name is unreachable for today's detections
        # (see _CLI_LOGIN_BRAND) but keeps an added CLI readable, not crashing.
        brand = _CLI_LOGIN_BRAND.get(det.name, det.name)
        return f"{brand} Subscription"
    # A cli-config detection carries the provider's own display name
    # ("Databricks AI Gateway"); other kinds ignore the keyword.
    return credential_label(det.kind, det.name, display_name=det.display_name)


def _announce_auto_configured_credentials(adopted: list[str]) -> None:
    """Print the "found existing credentials → auto-configured" callout.

    Re-runs ambient detection to recover each adopted credential, then prints a
    single compact, dimmed line naming them inline (e.g. ``Anthropic API Key,
    Claude Subscription, ChatGPT Subscription``) — so a user who never ran an
    explicit setup sees, the first time we auto-configure, exactly which
    credentials omnigent picked up (rather than silently inheriting them).
    Styled ``dim`` rather than the onboarding accent so it reads as a quiet
    notice, not a prominent header.

    :param adopted: Provider names just persisted by
        :func:`_adopt_detected_providers`, e.g. ``["anthropic", "codex"]``.
        A name with no matching live detection is skipped (defensive — the
        adopt set and the detection list come from the same detection pass, so
        in practice every name resolves).
    :returns: None. Side effect: writes the callout to the shared onboarding
        console (stdout). Prints nothing when no adopted name resolves to a
        live detection.
    """
    from omnigent.onboarding.ambient import detect_providers
    from omnigent.onboarding.interactive import console

    detected = {det.name: det for det in detect_providers()}
    labels = [_compact_credential_label(detected[name]) for name in adopted if name in detected]
    if not labels:
        return
    console.print(
        "\n[dim]Found existing credentials on your machine, "
        f"auto-configured for omnigent: {', '.join(labels)}[/dim]"
    )


def _adopt_ambient_credentials(progress: RunnerStartupProgress | None = None) -> list[str]:
    """Self-heal config, adopt ambient credentials, and announce what was added.

    The shared front half of both a bare ``omnigent run``'s first-run path
    (:func:`_resolve_first_run_plan`) and the ``configure harnesses`` picker
    (:func:`_run_configure_harnesses_interactive`): it (1) adopts any
    ambient-detected credential (env API key, logged-in ``claude`` / ``codex``
    CLI, local Ollama) not already configured as an ordinary provider entry,
    and (2) prints a callout naming exactly the credentials it just
    auto-configured. Idempotent: a second open adopts nothing, so no callout
    prints.

    :param progress: Optional spinner handle (from
        :func:`omnigent._runner_startup.runner_startup_progress`) covering the
        detection step — slow on macOS, where Claude detection now shells out to
        ``claude auth status`` to read the Keychain. When supplied, it is
        ``finish()``-ed (the spinner cleared) right before the callout prints,
        so the "Found existing credentials…" line is not clobbered by the
        animating spinner. ``None`` (the ``run`` first-run path) means no
        spinner — behavior is unchanged.
    :returns: The provider names adopted this call, e.g. ``["anthropic"]``;
        empty when every detection was already configured.
    """
    adopted = _adopt_detected_providers()
    # Clear the search spinner (if any) before printing — the callout writes to
    # stdout while the spinner animates on stderr, and on a shared TTY the two
    # would otherwise overwrite each other.
    if progress is not None:
        progress.finish()
    if adopted:
        _announce_auto_configured_credentials(adopted)
    return adopted


@dataclass(frozen=True)
class _HarnessMenuRow:
    """One selectable row in a harness's provider-management menu (level 2).

    :param label: Display text, e.g. ``"🔑 anthropic   ✓ default"``.
    :param action: The action on Enter — ``"set_default"`` / ``"add"`` /
        ``"remove"`` / ``"back"``.
    :param provider: For ``set_default``, the provider name to default;
        ``None`` for the other actions.
    """

    label: str
    action: str
    provider: str | None = None


def _credential_label(name: str, entry: ProviderEntry) -> str:
    """A friendly, jargon-free label for a configured credential.

    A logged-in CLI reads as ``"Subscription"`` (within a harness there is only
    one, so the plan name adds no information); an API-key provider names the
    vendor and the credential type (``"Anthropic API Key"`` / ``"OpenAI API
    Key"``); Databricks as ``"Databricks (<profile>)"``; a gateway / local
    endpoint as its display name — so menus and summaries avoid raw provider
    ids and the word "provider".

    :param name: The provider id keyed under ``providers:``, e.g. ``"openai"``.
    :param entry: The parsed provider entry.
    :returns: A human label, e.g. ``"Anthropic API Key"`` or ``"Databricks (oss)"``.
    """
    from omnigent.onboarding.configure_models import credential_label
    from omnigent.onboarding.provider_config import SUBSCRIPTION_KIND

    # A Claude subscription whose real backing is Claude Code's managed-settings
    # gateway reads as that gateway (e.g. "Databricks AI Gateway") rather than
    # the generic "Subscription", so the credential the user recognizes is named
    # — the Claude analogue of the "Codex-Databricks" row. Display only; the
    # persisted entry stays a plain subscription (no new shape on disk).
    if entry.kind == SUBSCRIPTION_KIND and entry.cli == "claude":
        gateway = _claude_managed_gateway_label()
        if gateway is not None:
            return gateway
    if entry.kind == SUBSCRIPTION_KIND and entry.cli == "pi":
        return "Pi original auth"
    return credential_label(
        entry.kind, name, profile=entry.profile, display_name=entry.display_name
    )


def _harness_credential_rows(config: dict[str, Any], family: str) -> list[_HarnessMenuRow]:  # type: ignore[explicit-any]
    """Build the level-2 rows: each credential serving *family*, then ``+ Add``.

    Each credential row drills into level 3 (make default / remove). The
    current default is marked with a green ✓. ``+ Add a credential`` runs the
    add flow; ``← Back`` returns to the harness picker (as do Esc / ``q``).

    :param config: The parsed config mapping (``providers:`` block).
    :param family: The harness surface being managed.
    :returns: The ordered, all-selectable rows.
    """
    from omnigent.onboarding.configure_models import kind_glyph
    from omnigent.onboarding.provider_config import (
        load_providers,
        provider_families,
        surface_default_provider,
    )

    serving = [
        (name, entry)
        for name, entry in load_providers(config).items()
        if family in provider_families(entry)
    ]
    # The surface's effective default (for pi: explicit scope, else fallback)
    # so the ✓ always marks the credential the harness would actually use.
    default = surface_default_provider(config, family)
    rows: list[_HarnessMenuRow] = []
    for name, entry in serving:
        glyph = kind_glyph(entry.kind)
        cred = _family_credential_label(config, family, name, entry)
        # The current default renders bold-green with a ✓ so it stands out in
        # the list; the rest are plain. Provider names are markup-safe in
        # practice (same assumption select() already makes for every label).
        if default is not None and name == default.name:
            label = f"[bold green]{glyph} {cred}  ✓ default[/]"
        else:
            label = f"{glyph} {cred}"
        rows.append(_HarnessMenuRow(label, action="credential", provider=name))
    rows.append(_HarnessMenuRow("+ Add a credential", action="add"))
    rows.append(_HarnessMenuRow("← Back", action="back"))
    return rows


def _prompt_install_harness(family: str) -> bool:
    """Offer to install an uninstalled harness CLI; return whether to proceed.

    Shown when the user drills into a harness whose CLI isn't on PATH. Offers
    three choices: install it now (``npm install -g …``), go back, or print the
    command to run manually.

    :param family: The harness surface being configured (``"anthropic"`` /
        ``"openai"`` / ``"pi"``).
    :returns: ``True`` only when the CLI is installed afterward (user chose
        install and it succeeded), so the caller continues to credential
        configuration; ``False`` when the user declines, asks to run it
        themselves, the install fails, or they Esc — the caller returns to the
        harness picker.
    """
    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.harness_install import (
        harness_cli_version,
        harness_install_display,
        install_harness_cli,
    )
    from omnigent.onboarding.interactive import console, select

    label = family_label(family)
    cmd = harness_install_display(family)
    detected_version, range_str = harness_cli_version(family)
    if detected_version is None:
        prompt = f"{label}'s CLI is missing. Install it now?"
    else:
        prompt = f"{label}'s CLI is installed ({detected_version}) but not supported."
        if range_str:
            prompt += f" Required version: {range_str}."
        prompt += " Upgrade it now?"

    choice = select(
        prompt,
        [
            f"Yes — install ({cmd})",
            "No — back to harnesses",
            "I'll run it myself (show the command)",
        ],
        descriptions=[
            f"Runs `{cmd}`, then continues to credential setup.",
            "Return to the harness picker without installing.",
            "Print the command so you can install it yourself, then return.",
        ],
        default=0,
        clear_on_exit=True,
    )
    if choice == 0:
        console.print(f"  [dim]Installing {label} — running `{cmd}`…[/dim]")
        if install_harness_cli(family):
            console.print(f"  [green]✓ {label} installed[/green]")
            return True
        console.print(
            f"  [red]Install failed.[/red] Run it manually, then re-open: [bold]{cmd}[/bold]"
        )
        return False
    if choice == 2:  # run it yourself
        console.print(f"  Install {label} with:\n    [bold]{cmd}[/bold]")
    return False


def _manage_harness_providers(family: str) -> None:
    """Run the level-2 loop for one harness: pick a credential or add one.

    Selecting a credential opens level 3 (make default / remove); ``+ Add``
    runs the add flow. Esc (TTY) / ``q`` (fallback) returns to the harness
    picker. The menu re-renders (cleared in place) after each action so the
    session stays on one tidy screen.

    :param family: The harness family being managed.
    :returns: None.
    """
    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.harness_install import harness_cli_installed
    from omnigent.onboarding.interactive import select

    # If the harness CLI is missing or on an unsupported version, offer to
    # install/upgrade it before showing the credential menu. Declining (or
    # copy-the-command) returns to the harness picker — there's nothing to
    # configure for a harness you can't run.
    if not harness_cli_installed(family) and not _prompt_install_harness(family):
        return

    # Carry the prior action's confirmation as a transient status line so the
    # menu shows only the latest result — not an accumulating stack of "✓ …".
    status: str | None = None
    while True:
        rows = _harness_credential_rows(_load_global_config(), family)
        idx = select(
            f"{family_label(family)} — select or add a credential",
            [r.label for r in rows],
            clear_on_exit=True,
            status=status,
        )
        if idx < 0:  # Esc / q — back to the harness picker
            return
        row = rows[idx]
        if row.action == "back":
            return
        if row.action == "add":
            status = _configure_harness_add(family=family)
        elif row.action == "credential" and row.provider is not None:
            status = _manage_credential(row.provider, family)


def _manage_credential(provider: str, family: str) -> str | None:
    """Run the level-3 loop for one credential: make default / remove.

    Opened by selecting a credential at level 2. Offers ``Make default`` (only
    when it is not already this harness's default), ``Remove``, and ``← Back``.
    Make-default / remove return to level 2 with a confirmation; ``← Back`` /
    Esc / ``q`` return with no change.

    :param provider: The provider id of the chosen credential, e.g. ``"openai"``.
    :param family: The harness surface in context, ``"anthropic"`` /
        ``"openai"`` / ``"pi"``.
    :returns: A confirmation string to show as a transient status at level 2,
        or ``None`` when nothing changed.
    """
    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.interactive import select
    from omnigent.onboarding.provider_config import (
        SUBSCRIPTION_KIND,
        load_providers,
        surface_default_provider,
    )

    config = _load_global_config()
    entry = load_providers(config).get(provider)
    if entry is None:
        return None
    label = _family_credential_label(config, family, provider, entry)
    rows: list[_HarnessMenuRow] = []
    # "Make default" is offered unless this credential is already the
    # surface's *effective* default (matching the ✓ on the level-2 row) —
    # for pi that covers the fallback-driven default too, where offering
    # "make default" would be a confusing no-op.
    default = surface_default_provider(config, family)
    if default is None or default.name != provider:
        rows.append(
            _HarnessMenuRow(
                f"Make default for {family_label(family)}", action="set_default", provider=provider
            )
        )
    rows.append(_HarnessMenuRow("Remove", action="remove", provider=provider))
    rows.append(_HarnessMenuRow("← Back", action="back"))

    idx = select(label, [r.label for r in rows], clear_on_exit=True)
    if idx < 0:  # Esc / q — back to the credential list, no change
        return None
    row = rows[idx]
    if row.action == "back":
        return None
    if row.action == "set_default":
        return _set_harness_default(provider, family)
    # A subscription's credential lives in the harness CLI's own auth file, not
    # our config — so removing it means signing out of that CLI (otherwise the
    # login persists and ambient detection re-adopts it on the next open).
    if entry.kind == SUBSCRIPTION_KIND:
        return _remove_subscription(provider, family)
    return _remove_credential(provider)


def _remove_subscription(provider: str, family: str) -> str | None:
    """Sign out of the harness CLI and remove the subscription credential.

    Unlike a key/gateway provider (whose credential is ours to drop), a
    subscription is backed by the harness CLI's own login file
    (``~/.codex/auth.json`` / ``~/.claude/.credentials.json``). Deleting only
    our entry would leave that login in place — so it would still drive the
    standalone CLI, and ambient detection would re-adopt the subscription on the
    next ``configure`` open. So "remove" here runs the harness's own logout
    (``codex logout`` / ``claude auth logout``) and then drops our entry. Guarded
    by an explicit confirm (default No) because it signs the user out of the
    standalone CLI too. (To merely stop *using* a subscription while staying
    logged in, the user makes another provider the default instead.)

    :param provider: The subscription provider id, e.g. ``"codex-subscription"``.
    :param family: The harness family, ``"anthropic"`` (Claude) / ``"openai"``
        (Codex).
    :returns: A confirmation message for the level-2 status line, or ``None``
        when the user declined (nothing changed). Side effects: runs the
        harness logout command and writes ``~/.omnigent/config.yaml``.
    """
    from omnigent.onboarding.harness_install import harness_install_spec, harness_logout
    from omnigent.onboarding.interactive import select

    spec = harness_install_spec(family)
    disp = spec.display if spec is not None else family
    logout_cmd = (
        f"{spec.binary} {' '.join(spec.logout_args)}"
        if spec is not None and spec.logout_args is not None
        else "logout"
    )
    choice = select(
        f"Remove {disp} subscription?",
        [f"Yes — sign out of {disp} and remove", "No — keep it"],
        descriptions=[
            f"Runs `{logout_cmd}`, signing you out of the standalone {disp} CLI "
            "too, then removes it here.",
            f"Leave the subscription and your {disp} login untouched.",
        ],
        default=1,  # default to the non-destructive choice
        clear_on_exit=True,
    )
    if choice != 0:
        return None
    signed_out = harness_logout(family)
    # Drop our entry regardless — the user asked to remove it. If logout failed
    # we say so, since the standalone login may persist (and be re-detected).
    _remove_credential(provider)
    if signed_out:
        return f"✓ Signed out of {disp} and removed"
    return (
        f"✓ Removed {disp} subscription — note: `{logout_cmd}` did not complete, "
        f"so you may still be signed in to the {disp} CLI"
    )


def _set_harness_default(provider: str, family: str) -> str | None:
    """Make *provider* the default for *family* and persist wholesale.

    :param provider: The provider name to default, e.g. ``"openrouter"``.
    :param family: The harness surface to scope the default to,
        ``"anthropic"``, ``"openai"``, or ``"pi"`` — leaving the other
        harnesses' defaults untouched.
    :returns: A confirmation message for the caller to show as a transient
        status, or ``None`` when there was nothing to do. Side effect:
        writes ``~/.omnigent/config.yaml``.
    """
    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.provider_config import load_providers, set_default_provider

    block = _load_global_config().get("providers")
    if not isinstance(block, dict):
        return None
    entry = load_providers({"providers": block}).get(provider)
    label = _credential_label(provider, entry) if entry is not None else provider
    _save_global_config({"providers": set_default_provider(block, provider, family)})
    return f"✓ {label} is now the {family_label(family)} default"


def _clear_detection_dismissal(name: str) -> None:
    """Drop *name* from the persisted ``dismissed_detections`` list, if present.

    Called when the user explicitly re-adds a previously Removed (and thus
    dismissed) ambient credential — e.g. picking the detected codex
    config.toml provider from the add menu — so the detection behaves like
    an ordinary one again.

    :param name: The detection name to un-dismiss, e.g. ``"codex-databricks"``.
    :returns: None. Side effect: writes ``~/.omnigent/config.yaml`` when the
        name was dismissed; no write otherwise.
    """
    from omnigent.onboarding.detected import (
        DISMISSED_DETECTIONS_KEY,
        dismissed_detection_names,
    )

    dismissed = dismissed_detection_names(_load_global_config())
    if name not in dismissed:
        return
    _save_global_config({DISMISSED_DETECTIONS_KEY: sorted(dismissed - {name})})


def _remove_credential(provider: str) -> str | None:
    """Remove the *provider* credential and persist wholesale.

    The stored secret (if any) is left in place — removing a credential does
    not assume its key is unwanted.

    :param provider: The provider id to remove, e.g. ``"openrouter"``.
    :returns: A confirmation message for the caller to show as a transient
        status, or ``None`` when there was nothing to remove. Side effect:
        writes ``~/.omnigent/config.yaml`` (and, when the removed entry is
        backed by a live ambient detection that cannot be signed out,
        records its name under ``dismissed_detections`` so the next
        configure open does not silently re-adopt it).
    """
    from omnigent.onboarding.ambient import detect_providers
    from omnigent.onboarding.detected import (
        DISMISSED_DETECTIONS_KEY,
        dismissed_detection_names,
    )
    from omnigent.onboarding.provider_config import load_providers

    config = _load_global_config()
    block = config.get("providers")
    if not isinstance(block, dict) or provider not in block:
        return None
    entry = load_providers({"providers": block}).get(provider)
    label = _credential_label(provider, entry) if entry is not None else provider
    remaining = {k: v for k, v in block.items() if k != provider}
    settings: dict[str, Any] = {"providers": remaining}  # type: ignore[explicit-any]  # yaml-boundary mapping
    # If a live ambient detection backs this entry, removing the entry alone
    # is a no-op: the next configure open re-detects and re-adopts it (the
    # "Remove doesn't remove" bug). Subscriptions are exempt — their removal
    # path signs out of the CLI instead, and a future re-login SHOULD
    # re-adopt. Everything else (env API key, codex config.toml provider,
    # local Ollama) gets a persisted dismissal that the add menu's detected
    # option clears on re-add.
    backing = next(
        (d for d in detect_providers() if d.name == provider and d.kind != "subscription"),
        None,
    )
    if backing is not None:
        settings[DISMISSED_DETECTIONS_KEY] = sorted(dismissed_detection_names(config) | {provider})
    _save_global_config(settings)  # wholesale replace per key
    if backing is not None:
        return f"✓ Removed {label} — it stays on your machine but won't be auto-configured again"
    return f"✓ Removed {label}"


def _run_configure_harnesses_interactive() -> None:
    """Run the interactive model/credential three-level picker.

    Invoked by ``omnigent setup`` and the bare-``run``
    first-run path, so both drive the identical flow.
    Opening it adopts any ambient-detected credential — announcing the
    newly auto-configured machine credentials in a callout — then loops on
    the level-1 harness overview. Every harness is shown on a single compact
    row — the harness name on the left, then an aligned ``✓``/``✗`` status
    column (the configured credential, or "Not installed" / "Not configured")
    — in priority order: Claude, Codex, Pi.
    The actionable hint (install command / next step) renders only for the
    highlighted row, as the selector's description line, so the overview stays
    uncluttered.

    :returns: None. Side effect: may write ``~/.omnigent/config.yaml`` via
        the backfill/adopt steps and any add/set-default/remove the user
        performs while navigating.
    """
    from rich.cells import cell_len
    from rich.markup import escape

    from omnigent.onboarding.configure_models import family_label
    from omnigent.onboarding.harness_install import (
        harness_cli_installed,
        harness_install_display,
        harness_install_spec,
    )
    from omnigent.onboarding.interactive import select
    from omnigent.onboarding.provider_config import (
        ANTHROPIC_FAMILY,
        OPENAI_FAMILY,
        PI_SURFACE,
        surface_default_provider,
    )

    # Surface missing external tooling (Node ≥22.10 / tmux) the harnesses need,
    # once up front, so configuring a credential doesn't lead to a cryptic
    # failure when the harness later can't launch.
    _warn_missing_harness_dependencies()

    # Adopt ambient detections: newly-adopted machine credentials get a
    # one-time callout naming what was auto-configured and from where. No progress spinner here: a
    # transient spinner over the (fast) detection left a cleared-region gap and
    # a residual line directly above the menu on first paint.
    _adopt_ambient_credentials()

    # Level 1: pick a harness. The cursor moves between Claude, Codex, Pi, and
    # Quit. Drilling in (level 2) keeps add/manage off this
    # overview. The menu clears in place on each choice so the session stays on
    # one screen. Quit / Esc / q exits.
    _QUIT = "\x00quit"  # sentinel marking the Quit row (not a family)
    families = [ANTHROPIC_FAMILY, OPENAI_FAMILY, PI_SURFACE]

    # Status glyph + Rich color per readiness kind: "ready" is a configured,
    # launchable harness (green ✓); "missing" is an absent CLI/SDK (red ✗);
    # "warn" is installed-but-unconfigured (yellow ✗ — present, not usable
    # yet). The glyph leads the status, which sits in a left-aligned column right of the
    # names, so every ✓/✗ lines up in a single column.
    status_styles = {
        "ready": ("✓", "green"),
        "missing": ("✗", "red"),
        "warn": ("✗", "yellow"),
    }

    def _cli_absence_label(key: str) -> str:
        """Return a status label that distinguishes "missing" from "outdated".

        When the binary is on PATH but ``harness_cli_installed`` is False, the
        CLI is installed but on an unsupported version; saying "Not installed"
        in that case is confusing for a user who knows they have the CLI.
        """
        from omnigent._platform import resolve_cli_binary

        spec = harness_install_spec(key)
        if spec is not None and resolve_cli_binary(spec.binary) is not None:
            return "Needs upgrade"
        return "Not installed"

    def _install_hint(command: str) -> str:
        # Selection-only tooltip. The command is escaped so a bracketed extra
        # renders literally instead of parsing as Rich markup.
        return f"Install with `{escape(command)}`"

    def _truncate_cells(text: str, max_cells: int) -> str:
        """Truncate *text* to a terminal-cell budget, adding an ellipsis if needed."""
        if cell_len(text) <= max_cells:
            return text
        ellipsis = "…"
        budget = max(0, max_cells - cell_len(ellipsis))
        out: list[str] = []
        used = 0
        for ch in text:
            width = cell_len(ch)
            if used + width > budget:
                break
            out.append(ch)
            used += width
        return "".join(out) + ellipsis

    def _family_row(fam: str) -> tuple[str, str, str, str, str]:
        # Claude / Codex / Pi: a CLI binary plus a usable default credential.
        # Pi's default is its *effective* one (explicit pi scope, else the
        # cross-family fallback).
        name = family_label(fam)
        if not harness_cli_installed(fam):
            return (
                fam,
                name,
                _cli_absence_label(fam),
                "missing",
                _install_hint(harness_install_display(fam)),
            )
        default = surface_default_provider(config, fam)
        if default is None:
            return (fam, name, "Not configured", "warn", "Open to add a credential.")
        label = _family_credential_label(config, fam, default.name, default)
        return (fam, name, label, "ready", "")

    def build_harness_rows() -> list[tuple[str, str, str, str, str]]:
        # One visible row per harness, in priority order. Each row is
        # (target, name, status, kind, hint), where ``hint`` is the
        # selection-only description (install command / next step), empty for
        # a ready harness.
        return [_family_row(fam) for fam in families]

    while True:
        config = _load_global_config()
        harness_rows = build_harness_rows()
        # Place the status in a single column a fixed gutter right of the names,
        # so every ✓/✗ glyph lines up vertically (the earlier right-aligned
        # status scattered the glyphs and read as messy). The name column is the
        # widest harness name + a 4-space gutter; the status is escaped when
        # interpolated into markup so a credential label containing a ``[`` can't
        # parse as a Rich tag (descriptions are escaped the same way).
        name_col = max(len(name) for _t, name, *_rest in harness_rows) + 4
        term_width = max(40, shutil.get_terminal_size(fallback=(80, 24)).columns)
        # _render_menu prefixes selected rows with ``"    ❯  "`` (7 cells).
        # Cap the status text from the actual terminal width so verbose status
        # rows do not wrap in the compact single-line overview.
        max_status_width = max(1, min(30, term_width - 7 - name_col - len("✓ ")))
        options: list[str] = []
        selectable: list[bool] = []
        row_target: list[str | None] = []
        descriptions: list[str] = []
        for row_key, name, status_text, kind, desc in harness_rows:
            status_text = _truncate_cells(status_text, max_status_width)
            glyph, color = status_styles[kind]
            options.append(f"{name.ljust(name_col)}[{color}]{glyph} {escape(status_text)}[/]")
            selectable.append(True)
            row_target.append(row_key)
            descriptions.append(desc)
        options.append("Quit")
        selectable.append(True)
        row_target.append(_QUIT)
        descriptions.append("")
        idx = select(
            "Configure harnesses",
            options,
            descriptions=descriptions,
            selectable=selectable,
            clear_on_exit=True,
            compact=True,
        )
        if idx < 0:  # Esc / q — exit
            return
        selected_target = row_target[idx]
        if isinstance(selected_target, str) and selected_target in families:
            _manage_harness_providers(selected_target)
        else:  # Quit row
            return
