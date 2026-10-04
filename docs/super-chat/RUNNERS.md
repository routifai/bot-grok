# Where a Muse's turns run

Every Super Chat / side chat / Helper turn is executed by an Omnigent
**runner** — a short-lived process that holds the harness (Claude SDK) and
does the actual work. The runner always lives inside a **host**: a process
that dials the Omnigent server and spawns runners on demand. This page is
about where that host runs, and how it gets the credentials and settings a
runner needs.

## Two runner locations

| Location | Host lives in | Used for |
|---|---|---|
| **Computer** (default) | A per-Muse Docker container, managed by Nova's own sandbox supervisor (`infra/sandboxes/supervisor`, `infra/sandboxes/computer`) | Normal operation — every Muse gets its own persistent computer |
| **Laptop** (dev option) | The developer's own machine, running `omnigent host` directly | Local development without Docker |

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
  server_url: http://host.docker.internal:8000
  runner_env: [ANTHROPIC_API_KEY, TAVILY_API_KEY, NOVA_CLAUDE_MODEL,
               OMNIGENT_ROLLOVER_IDLE_REFRESH_SECONDS, OMNIGENT_SUBAGENT_MAX_CONCURRENT]
```

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

Plus the usual `sandbox.server_url` (the engine server's own public URL, so
the host inside the container can dial back) and `sandbox.host_config` for
any non-secret in-sandbox provider config.

## Running the computer path locally

In order, each depending on the one before:

1. **Postgres** — the engine server's store.
2. **Build the computer image** — `docker build -t aiden/computer:local -f infra/sandboxes/computer/Dockerfile .` (repo root context; also `pnpm sandbox:build`). The supervisor does **not** auto-build this image — if it's missing, `POST /computers` fails with this exact command in the error.
3. **Nova's sandbox supervisor** (`infra/sandboxes/supervisor`) — needs the Docker socket.
4. **The Omnigent server**, configured with the `sandbox:` block above and the required env from the previous section.
5. **Nova's own `apps/api`, `apps/worker`, `apps/web`** — talk to the Omnigent server through the gateway.

## Known gaps

- **Header-auth managed host tokens.** The managed-host launch token is a
  bearer the host dials back with; there is no documented path for a
  deployment that needs a different (header-based) auth scheme between the
  host and the server.
- **Home path keying in team mode.** The computer provider keys a Muse's
  persistent home by `bot_id` alone (`home_path = <root>/homes/<bot_id>`,
  `omnigent/onboarding/sandboxes/computer.py`). If a bot is ever shared
  across multiple users/spaces ("team mode"), they would all resolve to the
  same home directory — this has no per-user or per-space isolation today.
- **Egress.** The computer container has no documented outbound network
  restriction. A turn's tools (web search, browser use) and the harness
  itself can reach the open internet from inside the container; there is no
  allowlist/firewall layer in `infra/sandboxes/computer` today.
