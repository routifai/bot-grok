# Where a Muse's turns run

Every Super Chat / side chat / Helper turn is executed by an Omnigent
**runner** — a short-lived process that holds the harness (Claude SDK) and
does the actual work. The runner always lives inside a **host**: a process
that dials the Omnigent server and spawns runners on demand. This page is
about where that host runs, and how it gets the credentials and settings a
runner needs.

## Runner location

Every runner lives in the Muse's **Computer**: a per-Muse Docker container
managed by Nova's sandbox supervisor (`infra/sandboxes/supervisor`,
`infra/sandboxes/computer`). There is no laptop (`omnigent host`) location.

Nova's gateway (`packages/adapters/src/omnigent/gateway.ts`,
`resolveRunnerBinding`) picks "computer" by selecting the Omnigent
`"computer"` sandbox provider
(`engine/omnigent/omnigent/onboarding/sandboxes/computer.py`). The engine
server provisions the container through Nova's supervisor, starts
`omnigent host` inside it, and that host spawns runners for every turn —
see `engine/omnigent/omnigent/server/managed_hosts.py`
(`launch_managed_host`) and
`engine/omnigent/omnigent/onboarding/sandboxes/base.py`
(`ExecModelHostLauncher.start_host`).

The computer container is Nova's, not the session's: it outlives any one
conversation (skills, canvas, and browser use share it too), and a repeated
launch for the same Muse reuses the same container and the same supervised
`omnigent host` loop rather than piling up a second one.

## How keys and settings reach a runner

A runner only ever sees what its agent spec gives it, plus a small
allowlist of process essentials (`PATH`, `HOME`, locale, …) — see
`_RUNNER_ENV_ALLOWLIST` in `engine/omnigent/omnigent/host/connect.py`. Two
things widen that on purpose:

- **Harness credentials** (`ANTHROPIC_API_KEY` and friends —
  `HARNESS_CREDENTIAL_ENV_VARS` in `connect.py`) forward automatically when
  present in the **host's own** process environment.
- **`OMNIGENT_RUNNER_ENV_PASSTHROUGH`**, a comma-separated list of extra
  variable names the host owner names explicitly (e.g. `TAVILY_API_KEY` for
  web search), also read from the host's own environment.

Both of those depend on the variable already being set in the *host's*
environment. On a laptop that's just the developer's shell. A managed host
(the computer provider) has no shell of its own — its process environment is
whatever the launcher gives it — so the Omnigent **server's** config has to
say which of its own environment variables to hand down:

```yaml
sandbox:
  provider: computer
  server_url: http://<host reachable from the container>:<the server's port>
  runner_env: [ANTHROPIC_API_KEY, TAVILY_API_KEY, NOVA_CLAUDE_MODEL,
               OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS, OMNIGENT_SUBAGENT_MAX_CONCURRENT,
               OMNIGENT_BROWSER_BACKEND, OMNIGENT_HELPER_MODEL_FAST,
               OMNIGENT_HELPER_MODEL_STRONG]
```

`OMNIGENT_HELPER_MODEL_FAST` / `OMNIGENT_HELPER_MODEL_STRONG` map `start_helper`'s `fast` and
`strong` to model ids (set them in the server's environment and name them in `runner_env`);
a choice with no id set runs on the calling session's own model. On a multi-model harness (Pi) the
global ids do not apply: set `OMNIGENT_HELPER_MODEL_FAST_PI` / `OMNIGENT_HELPER_MODEL_STRONG_PI`
(also in `runner_env`), or Pi Helpers run on the parent's model.

`OMNIGENT_BROWSER_BACKEND=local` (set in the Omnigent server's own environment,
and named in `runner_env` above) makes the `browser_*` tools drive the
Chromium on the Computer's own screen (via `aiden-browser` /
`aiden-page-browser`, `engine/omnigent/omnigent/tools/browser_backend.py`)
instead of relaying to the desktop app. Unset, the default desktop backend
applies, so a Computer without this variable has no working browser tools.

`sandbox.runner_env` is a list of **names only** — never values — so it's
safe to commit and safe to log. At launch, the server resolves each name
against its *own* process environment (whatever was set when the Omnigent
server started) and passes the ones that are actually set to the host
process it starts inside the computer container; it also sets
`OMNIGENT_RUNNER_ENV_PASSTHROUGH` to that same list, so the host forwards
them to every runner exactly like a laptop host already forwards whatever
is in the developer's shell. Values are delivered to the exec call that
starts the host, not interpolated into any command string, so they never
show up in `ps` output or in either side's logs.

This is provider-neutral config (any managed-launch provider can set
`sandbox.runner_env`), but today it is only *wired up* for exec-model
providers whose launcher accepts it — in practice, `computer`.

## Required server environment

The Omnigent server process itself needs:

| Variable | What it is |
|---|---|
| `OMNIGENT_NOVA_SUPERVISOR_URL` | Base URL of Nova's sandbox supervisor, e.g. `http://localhost:7091` |
| `OMNIGENT_NOVA_SUPERVISOR_TOKEN` | The shared bearer the supervisor expects on every request (same secret Nova's own API process uses — `resolveSupervisorToken` / `SANDBOX_SUPERVISOR_TOKEN`) |
| `OMNIGENT_NOVA_HOME_ROOT` | Root directory a Muse's persistent home lives under (`<root>/homes/<bot_id>`) — must resolve to the SAME host path Nova's API process uses (`resolveAgentHomePath` in `packages/adapters/src/home.ts`). Defaults to `./data` for local/dev parity only. |

Plus the usual `sandbox.server_url` (the engine server's own URL on the
server's port, reachable from inside the container so the host can dial back) and `sandbox.host_config` for
any non-secret in-sandbox provider config.

Deployment requirements found live:

- With a `sandbox:` block in the server config, the Omnigent server must pin
  `OMNIGENT_AUTH_PROVIDER=header` (Nova calls it with header auth).
- Nova's api/worker `DATA_DIR` must equal the supervisor's `DATA_DIR`: the
  supervisor accepts only `homePath = <dataDir>/homes/<botId>` and rejects
  anything else (`assertBotHomePath`, `infra/sandboxes/supervisor/src/index.ts`).
- Sessions carry `nova.bot` / `nova.space` and an optional `nova.computer`
  label. The computer provider prefers `nova.computer` (the machine Nova
  shows the person, shared per space in team mode) and falls back to
  `nova.bot` (`prepare_for_launch`, `computer.py`).

## The Computer: screen and Take over

The engine owns the Computer (ADR 0004); Nova holds no Computer state and
only relays.

- The computer provider re-resolves a recreated container by Muse identity
  (bot + space), so a supervisor-side recreate does not strand the session.
- The provider declares `SandboxCapabilities.screen`
  (`sandboxes/base.py`: `screen_url`, `release_control`). Session routes
  (`server/routes/sessions/routes_computer.py`): `GET /v1/sessions/{id}/computer`
  (`{available, in_control}`), `POST .../computer/screen` `{interactive}`
  (`true` = Take over: mints a control token), `POST .../computer/release`.
- The supervisor's `screen-mode` returns the Muse's X `display`; the provider
  forwards it to the runner as `DISPLAY`, so the viewer and the runner share
  one screen.
- Nova's API (`apps/api/src/engine-computer.ts`) calls those routes and
  relays the noVNC stream through its same-origin screen proxy; browsers
  never reach the engine.
- While the person holds control, the Muse's computer tools (`sys_os_*`,
  `browser_*`) refuse (`tool_dispatch.py` asks `GET .../computer`).
- The Computer is always on. The Pi-era idle sleep and control-expire jobs
  skip engine Muses.
- Browser tools need `OMNIGENT_BROWSER_BACKEND=local` (above).

## Running the computer path locally

In order, each depending on the one before:

1. **Postgres** — the engine server's store.
2. **Build the computer image** — `docker build -t aiden/computer:local -f infra/sandboxes/computer/Dockerfile .` (repo root context; also `pnpm sandbox:build`). The supervisor does **not** auto-build this image — if it's missing, `POST /computers` fails with this exact command in the error.
3. **Nova's sandbox supervisor** (`infra/sandboxes/supervisor`) — needs the Docker socket.
4. **The Omnigent server**, configured with the `sandbox:` block above and the required env from the previous section. Install the engine with the `memory` extra (`uv sync --extra memory ...`); without it the memory routes are not mounted and the Muse's memory tools fail with "not configured". On macOS the memory stack also needs `KMP_DUPLICATE_LIB_OK=TRUE` in the server's environment.
5. **Nova's own `apps/api`, `apps/worker`, `apps/web`** — talk to the Omnigent server through the gateway.

## Known gaps

- **Runner token owner-scoped.** The runner's token belongs to its owner; no
  shared-space token exists.
- **Terminate not implemented.** By design: the Computer is always on, so
  the engine never stops it.
- **Egress unfiltered.** The computer container has no outbound network
  restriction. Tools (web search, browser use) and the harness can reach the
  open internet; there is no allowlist or firewall layer in
  `infra/sandboxes/computer` today.
- **Home path keying in team mode.** The provider keys a Muse's persistent
  home by `bot_id` alone (`<root>/homes/<bot_id>`, `computer.py`). A bot
  shared across users/spaces would resolve to one home; no per-user or
  per-space isolation today.
- **Take-over state persistence.** Control state is being moved into the
  engine's own store. Until that lands it is an in-memory map in
  `routes_computer.py` and is lost on an engine restart.
