# Omnigent spike (week 1)

> **Historical. Superseded by `docs/super-chat/README.md` and `WIRING.md`.** The week-1 shape this page
> describes — four selectable harnesses (`pi`/`claude`/`openai`/`codex`), the
> `nova_*` builtin tools, and the `/internal/omnigent/context` context-provider hook — has been
> replaced by `omnigent.context.mode=superside-chat` (slice A1): a single `nova-claude` Super
> Chat bundle, with Memory, Rollover, Side Chats and the Activity Feed owned entirely by
> Omnigent. Everything below is kept for history; read the Super Chat docs for what's current.

Nova is moving its agent loop onto [Omnigent](https://github.com/omnigent-ai/omnigent) (vendored
read-only at `engine/omnigent/`, upstream `omnigent-main`): Omnigent runs the agent loop, tools,
policies, and harness switching; Nova stays the context layer and product UI. This spike lets one
Nova Conversation turn run on Omnigent, on whichever harness the person has chosen for their Muse
(`pi`, `claude`, `openai`, or `codex` — see "Choosing a harness" below), with Nova's person
context injected into the instructions, whenever the connection (`OMNIGENT_URL` + `OMNIGENT_PROXY_SECRET`) is configured (the old
`NOVA_ENGINE` flag is gone). With the connection unset, nothing here changes — the existing engine (`packages/adapters/src/executor/`) is
untouched and still the default.

## What's here

- **Context-provider endpoint** — `POST /internal/omnigent/context` in `apps/api` (plain Hono
  route, not oRPC, not behind user auth). Composed by
  `packages/adapters/src/omnigent/context-provider.ts` (`composeOmnigentContext`), reusing the
  same builders the existing engine uses: the static Muse voice/reply/goals instructions
  (`packages/adapters/src/executor/run-prompt.ts`), durable memory (`memory-context.ts`),
  scratchpad, active Goals, ranked past episodes, taught/agent skills, and the current date/time
  in the person's timezone. Everything is redacted with the same `redactSecrets` the executor
  uses, and capped at 48 KB total.
- **Scope isolation** — Omnigent sets a session label `nova.scope`. Only `"private"` gets the full
  context above; any other value (a future `"project"` scope) gets just the static instructions —
  no memory, scratchpad, Goals, or episodes. See
  `packages/adapters/src/omnigent/context-provider.test.ts` for the canary-string isolation
  tests.
- **Agent bundles** — `infra/omnigent/agents/nova-{pi,claude,openai,codex}/`, each a
  directory-bundle agent (`config.yaml` + `AGENTS.md`) generated from one shared template
  (`infra/omnigent/templates/`) by `node infra/omnigent/render-agents.mjs`, so the four harness
  variants differ only in `executor.config.harness`/`model`. Tools are `web_search` and
  `web_fetch` builtins only for week 1. `AGENTS.md` just says to follow
  `<deployment_context>` — all the real per-turn instructions arrive through the context-provider
  hook.
- **Harness choice** — one deployment flag, `NOVA_MUSE_HARNESS` (`claude-sdk` default | `pi`),
  picks the Muse's bundle by name in `packages/adapters/src/omnigent/env.ts`
  (`museAgentNameFromEnv`): `nova-claude` or `nova-pi`, both rendered from the same templates.
  There is no per-Muse choice and no `engine.*` route.
- **Gateway** — `packages/adapters/src/omnigent/client.ts` (a small typed REST client:
  create/get sessions, post a message event, stream SSE, list items, switch a session's agent —
  no SDK, just `fetch` and a tiny SSE parser mirroring `apps/mobile/lib/api.ts`'s
  `subscribeThread`) and `packages/adapters/src/omnigent/gateway.ts` (`runTurnOnOmnigent`): gets
  or creates the Muse's Omnigent session (one per bot, id and current agent name stored in the
  `omnigent_sessions` table), switches the session to the bot's chosen harness first if it's
  running a different one (`POST /sessions/{id}/switch-agent`, idle-only — a failed switch is
  logged and the turn continues on the session's current agent instead of failing), posts the
  turn's message, waits for `response.completed`, and writes the final assistant text into the
  Nova thread with the same `ThreadEvents.finalizeRun` helper the existing engine uses — so the
  web app shows it like any other bot reply.
- **Switch** — `packages/adapters/src/background-job-handlers.ts`'s `"run.continue"` handler calls
  `runTurnOnOmnigent` first when the Omnigent connection is configured, falling back to
  `executor.continueRun` when the run isn't eligible (see "Eligibility" below) or when the
  connection is unset. Both `apps/worker` and `apps/api` (which also runs job handlers when
  `WAKEUP_DRIVER=memory`) wire this identically through
  `packages/adapters/src/omnigent/env.ts`'s `omnigentGatewayDepsFromEnv`.

### Choosing a harness

Set `NOVA_MUSE_HARNESS=pi` to run the Muse on Pi; unset (or `claude-sdk`) runs it on the Claude
Agent SDK. An explicit `OMNIGENT_AGENT_NAME` overrides the flag. An existing Conversation moves
over through Omnigent's switch-agent before its next turn (see "Gateway" above). The switch is
total: the Muse and every Helper type, scheduled and background runs included, share the
bundle's harness.

### The Nova computer runner launcher

Omnigent runners (where a harness like Pi, Claude, Codex, or a future Hermes executes and runs
its shell, file, and browser tools) must run inside each Muse's own sandbox computer, never on the
Omnigent server process and never on the machine that happens to be running it. Topology:

```
Nova (apps/api / apps/worker)                Omnigent server
  gateway.ts ── POST /v1/sessions ──────────►   host_type: "managed", sandbox_provider: "computer"
  (nova.bot / nova.user / nova.space labels)    │
                                                 ▼
                                        ComputerSandboxLauncher
                                     (engine/omnigent/omnigent/onboarding/
                                        sandboxes/computer.py)
                                                 │  POST /computers, /computers/{id}/exec
                                                 ▼
                                     Nova's sandbox supervisor (infra/sandboxes/supervisor)
                                                 │  ensures the container is running, execs into it
                                                 ▼
                                     The Muse's own computer container
                                        (infra/sandboxes/computer image)
                                          └── `omnigent host` runs here, dials back to the
                                              Omnigent server over the runner WS tunnel
```

versus the **local** location, which never touches the computer at all — Omnigent routes to
whichever machine the person already has a connected `omnigent host` on (`host_type: "external"`,
a caller-supplied `host_id` + an absolute workspace path on that host):

```
Nova (apps/api / apps/worker)                Omnigent server
  gateway.ts ── GET /v1/hosts ──────────────►   (find the caller's own online, non-sandbox host)
  gateway.ts ── POST /v1/sessions ──────────►   host_type: "external", host_id, workspace
                (host_id, ~/nova/<botId>)                │
                                                          ▼
                                              The person's own machine, already running
                                                 `omnigent host` (unrelated to Nova's
                                                 sandbox supervisor entirely)
```

**Choosing where**, per Muse: `Bot.museRunnerLocation` (`NovaRunnerLocationId`, "computer" |
"local", `packages/contracts/src/engine.ts`) — `null` defaults to `"computer"`. Read/write it the
same way as the harness choice: `engine.info` returns the resolved `runnerLocation`;
`engine.setRunnerLocation({ botId, runnerLocation })` persists a new one. No UI surfaces this yet
(the RPC and contract field exist; nothing calls `setRunnerLocation` outside tests). A changed
runner location takes effect on the Muse's *next* turn: `ensureOmnigentSession` in
`packages/adapters/src/omnigent/gateway.ts` compares the bot's current resolved location against
the one its existing Omnigent session was created with (`omnigent_sessions.runnerLocation`) and,
on a mismatch, creates a brand-new Omnigent session bound the new way — there is no in-place
"switch location" the way `switch-agent` rebinds harnesses, so the Omnigent-side conversation
history for that Muse starts over (Nova's own thread history is untouched; only the Omnigent
session backing it is replaced).

**Binding at session creation, not after.** Posting a message to an Omnigent session with no host
ever bound fails immediately with `"no runner bound for session"` — a session created with only
`agent_id` + `labels` (the original week-1 gateway body) never gets one, since Omnigent's
`host_type` defaults to `"external"` with no `host_id` (a caller-managed runner that nothing ever
provides here). `ensureOmnigentSession`'s create path fixes this by always setting `host_type`
explicitly — `"managed"` + `sandbox_provider: "computer"` for the default location, or
`"external"` + a resolved `host_id`/`workspace` for `"local"` (failing the turn with a clear error
naming `omnigent host` when the person has no host currently connected). Sessions created before
this fix (or a managed launch that otherwise never bound a host) are repaired on their *next*
turn: the reused-session path fetches a cheap snapshot (`GET /v1/sessions/{id}`) and, when
`host_id` is still null, recreates the session the same way a fresh one would be created.

**The launcher** (`ComputerSandboxLauncher`, `engine/omnigent/omnigent/onboarding/sandboxes/
computer.py`) implements Omnigent's `SandboxHostLauncher` interface exactly like every other
managed-sandbox provider (Modal, Boxlite, …) — register it with `sandbox.provider: computer` (or
in a `sandbox.providers:` list) in the Omnigent server config; it takes no `sandbox.computer:`
block, only the environment variables below. Unlike every other provider, its sandbox is not a
fresh box it creates: it is Nova's own pre-existing, per-Muse computer, keyed by the launching
session's `nova.bot`/`nova.space` labels (`prepare_for_launch`, threaded from the session row by
`omnigent.server.managed_hosts.launch_managed_host` on a first launch, or recovered from the
launcher's own previous `provision()` return value — which encodes that identity — on a relaunch
of an existing host). `provision()` calls the supervisor's `POST /computers`, which is itself an
ensure-or-create: idempotent, and already resumes a merely-*stopped* container in place, so the
launcher needs no liveness bookkeeping of its own. The runner authenticates to the Omnigent server
exactly the way every managed host already does — the short-lived, per-launch, owner-scoped host
launch token `start_host`'s inherited default injects — never a long-lived admin secret; Nova's
API-process-to-supervisor secret (below) is a completely separate credential the launcher uses
only to reach the supervisor, and never leaks into the sandbox. The launcher deliberately does
**not** implement `terminate`/`keep_alive`: the computer belongs to Nova and outlives any one
Omnigent session (skills, canvas, and browser use share it too), so Omnigent's best-effort sandbox
cleanup must never destroy it — every caller of those already treats "provider can't do that" as
skippable.

**The image**: `infra/sandboxes/computer/Dockerfile` now vendors `engine/omnigent` (an
`omnigent-builder` stage installs it with `uv` into `/opt/venv`, symlinked to `/usr/local/bin` so
it's on the sandbox supervisor's fixed exec `PATH`) plus Node and the `pi` CLI — the only external
harness CLI `omnigent/inner/pi_executor.py` needs; the other Nova harnesses (claude/openai/codex)
run through the omnigent Python package's own SDK dependencies, already installed. This changed
the image's Docker build **context** from `infra/sandboxes/computer` to the repo root (see
`infra/compose/docker-compose*.yml`, `scripts/setup.sh`, and the CI validate matrix) so the
Dockerfile can `COPY engine/omnigent/`.

Environment variables (Omnigent server process):

| Variable | Purpose |
| --- | --- |
| `OMNIGENT_NOVA_SUPERVISOR_URL` | Base URL of Nova's sandbox supervisor, e.g. `http://sandbox-supervisor:7091`. |
| `OMNIGENT_NOVA_SUPERVISOR_TOKEN` | The shared bearer Nova's supervisor expects on every request — the same secret Nova's own API process reads via `resolveSupervisorToken`/`SANDBOX_SUPERVISOR_TOKEN` (`packages/core/src/secrets-guard.ts`). Never a per-user credential. |
| `OMNIGENT_NOVA_HOME_ROOT` | Root directory a Muse's persistent home lives under (`<root>/homes/<bot_id>`) — must resolve to the SAME host path Nova's own API process uses (`dataDir` in `packages/adapters/src/home.ts`). Defaults to `./data` for local/dev parity only; set an absolute, shared path in any real deployment. |

**Known gaps, not yet proven end-to-end:**

- **The Muse's home directory must already exist.** Nova's API process normally creates it
  (`mkdir(homePath, { recursive: true })` in `packages/adapters/src/computer-lifecycle.ts`) before
  ever calling the supervisor; a root-mode supervisor deliberately never creates one itself. If a
  Muse's very first activity is an Omnigent turn (before Nova's own computer/browser features have
  ever touched it), `POST /computers` may fail until something on Nova's side has created the
  home directory at least once.
- **Relaunch/resume identity threading covers a fresh sandbox generation, not a resumed one.**
  `prepare_for_launch` receives the session's labels (or, on relaunch, the launcher's own
  previous sandbox id) from `omnigent.server.managed_hosts.launch_managed_host` /
  `relaunch_managed_host`. `resume_managed_host` (waking a *stopped-but-resumable* sandbox) is
  never reached for this provider — it's gated on `SandboxCapabilities.resume_stopped`, which this
  launcher deliberately leaves `False` (the supervisor's own `POST /computers` already resumes a
  stopped container transparently inside `provision()`).
- **The "local" workspace directory convention (`~/nova/<bot_id>`) is new and unproven against a
  real connected host** — verified only against the schema/validation rules read from source
  (`SessionCreateRequest`'s workspace-boundary checks in `engine/omnigent/omnigent/server/
  schemas.py`) and offline tests, not a live `omnigent host`.
- **No live run of a full turn against a real Nova supervisor + computer container** — the
  launcher is tested offline against a fake supervisor (`httpx.MockTransport`,
  `engine/omnigent/tests/onboarding/sandboxes/test_computer.py`), and the Docker image was built
  successfully locally, but nothing here has exercised the real `docker build` → supervisor →
  container → `omnigent host` → tunnel → runner chain end to end.

### Eligibility (what actually runs on Omnigent)

Only a plain user message (`run.trigger === "user"`) on a Muse's own private Conversation thread
(`thread.botId === run.botId`, no `goalId`) is eligible. Routines, Goal-log turns, group chats,
and messaging-channel runs always use the existing engine, flag or no flag — Omnigent's side of
this integration doesn't cover those yet.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `OMNIGENT_URL` | `apps/api`, `apps/worker` | Base URL of the Omnigent server, e.g. `http://127.0.0.1:8000`. Setting both this and the proxy secret routes eligible runs through the gateway. |
| `OMNIGENT_PROXY_SECRET` | `apps/api`, `apps/worker` | Shared secret sent as `X-Omnigent-Proxy-Secret` on every gateway call, alongside `X-Forwarded-Email` (the person's email) for Omnigent's header-auth mode. Required together with `OMNIGENT_URL`. |
| `OMNIGENT_AGENT_NAME` | `apps/api`, `apps/worker` | Overrides the Muse's agent bundle by name. Unset, `NOVA_MUSE_HARNESS` chooses between `nova-claude` (default) and `nova-pi`. |
| `OMNIGENT_CONTEXT_PROVIDER_SECRET` | `apps/api` | Bearer secret the context-provider route requires. **Unset 404s the route entirely** — set this to enable the endpoint. |
| `OPENROUTER_API_KEY` / `AIDEN_LOCAL_MODELS_URL` | `apps/api` | Either makes the `pi` harness available in `engine.info`'s catalog (Pi routes through OpenRouter or a locally configured OpenAI-compatible server). |
| `ANTHROPIC_API_KEY` | `apps/api` | Makes the `claude` harness (Claude Agent SDK) available in `engine.info`'s catalog. |
| `OPENAI_API_KEY` | `apps/api` | Makes both the `openai` (OpenAI Agents SDK) and `codex` (OpenAI's coding agent) harnesses available in `engine.info`'s catalog. |
| `NOVA_PI_MODEL` / `NOVA_CLAUDE_MODEL` / `NOVA_OPENAI_MODEL` / `NOVA_CODEX_MODEL` | Omnigent server process | Model id substituted into the matching generated bundle's `executor.config.model` (`${NOVA_PI_MODEL}`, etc.). Omnigent expands `${VAR}` server-side for built-in agents loaded via `OMNIGENT_BUILTIN_AGENT_DIRS`. Use a model id valid for that harness's configured provider, e.g. a Databricks/Anthropic Claude model id for `NOVA_CLAUDE_MODEL`. |

## Running Omnigent locally against Nova

From the repo root, with Nova's API running on `127.0.0.1:3100` (the default):

```bash
export OMNIGENT_CONTEXT_PROVIDER_URL=http://127.0.0.1:3100/internal/omnigent/context
export OMNIGENT_CONTEXT_PROVIDER_SECRET=some-long-random-dev-secret
export OMNIGENT_AUTH_HEADER_SECRET=some-long-random-dev-secret   # see Open Questions below
export OMNIGENT_BUILTIN_AGENT_DIRS="$(pwd)/infra/omnigent/agents/nova-claude:$(pwd)/infra/omnigent/agents/nova-pi"

uv run --project engine/omnigent omnigent server
```

(Docker-for-Nova / Omnigent-on-host: replace `127.0.0.1` in `OMNIGENT_CONTEXT_PROVIDER_URL` with
`host.docker.internal` so the container can reach Nova's API.)

Then, in Nova's own env (`apps/api` and `apps/worker`):

```bash
export OMNIGENT_URL=http://127.0.0.1:8000
export OMNIGENT_PROXY_SECRET=some-long-random-dev-secret   # must match OMNIGENT_AUTH_HEADER_SECRET above
export OMNIGENT_CONTEXT_PROVIDER_SECRET=some-long-random-dev-secret
export NOVA_PI_MODEL=databricks-claude-sonnet-4-6   # or whatever the local Omnigent provider serves
```

Regenerate the bundles after editing the template:

```bash
node infra/omnigent/render-agents.mjs
```

Restart the Omnigent server after changing a mounted bundle — `OMNIGENT_BUILTIN_AGENT_DIRS` is
only read at boot.

## Flipping the flag back off

Unset `OMNIGENT_URL` and `OMNIGENT_PROXY_SECRET` in `apps/api` and
`apps/worker` and restart both. No other cleanup is needed: the `omnigent_sessions` table is
additive and unused by the existing engine.

## Open questions / follow-ups for week 2

- **The context-provider hook is a parallel, not-yet-landed Omnigent patch.** `engine/omnigent/`
  as vendored today has no `<deployment_context>` support, `OMNIGENT_CONTEXT_PROVIDER_URL`, or
  `OMNIGENT_AUTH_HEADER_SECRET` — this doc and the route implement Nova's side of the contract as
  specified, but it can only be exercised end-to-end once that patch lands. Re-verify the exact
  request/response shape (and the `OMNIGENT_AUTH_HEADER_SECRET` name) against the real patch when
  it arrives.
- **No lease renewal or takeover.** `runTurnOnOmnigent` claims the run with a single
  `status: "queued" → "running"` update and a 5-minute lease, then finalizes once
  `response.completed`/`response.failed` arrives or after a 5-minute timeout. It does not renew
  the lease, so a turn that runs longer than 5 minutes keeps its DB lease past `leaseExpiresAt`
  even though the gateway is still waiting on Omnigent — a future reconciler pass could reclaim a
  run that is not actually stuck. The existing engine's heartbeat/lease-renewal machinery
  (`packages/adapters/src/executor/run-executor.ts`) was deliberately not replicated for this
  spike, since it exists to coordinate sandboxed tool execution Omnigent doesn't need. Worth
  revisiting if week 2 needs turns longer than a few minutes.
- **No crash recovery.** If the Nova process dies mid-turn after claiming the run but before
  `finalizeRun`, the run is stuck `"running"` until its lease expires; nothing currently reclaims
  it back onto the Omnigent path (the existing engine's `continueRun` would reclaim it onto the
  *old* engine instead, which doesn't know about the Omnigent session). Acceptable for a flagged
  spike; would need a proper reconciler before this becomes a real path.
- **Tool activity isn't surfaced.** The spec allows summarizing tool activity as a single
  progress line; week 1 skips it entirely (`response.output_item.*` events for non-message items
  are ignored) since the turn is otherwise text-only.
- **Agent id lookup happens once per bot, not cached across bots.** `ensureOmnigentSession` calls
  `GET /v1/agents` by name the first time a bot talks to Omnigent (and again on every harness
  switch), then remembers the session id from then on. If the built-in agent bundle is ever
  re-registered under a new id (e.g. after changing its `name`), existing bots will keep talking
  to the *session* they already created (unaffected) but a *new* bot's first turn — or a
  switch — would resolve whatever id currently answers to that name — should be fine as long as
  bundle names stay stable.
- **Harness switching has no user-visible feedback beyond the next reply.** A failed
  switch-agent call (session unexpectedly busy, target bundle failed to load) is only logged; the
  turn still completes on the previous harness with no signal to the person that their choice
  didn't take effect yet. The next turn retries the switch. Worth surfacing if this turns out to
  happen often in practice.
