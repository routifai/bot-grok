# Omnigent spike (week 1)

Nova is moving its agent loop onto [Omnigent](https://github.com/omnigent-ai/omnigent) (vendored
read-only at `engine/omnigent/`, upstream `omnigent-main`): Omnigent runs the agent loop, tools,
policies, and harness switching; Nova stays the context layer and product UI. This spike lets one
Nova Conversation turn run on Omnigent (the `pi` or `claude-sdk` harness) with Nova's person
context injected into the instructions, entirely behind the `NOVA_ENGINE=omnigent` flag. With the
flag unset, nothing here changes — the existing engine (`packages/adapters/src/executor/`) is
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
- **Agent bundles** — `infra/omnigent/agents/nova-pi/` and `infra/omnigent/agents/nova-claude/`,
  each a directory-bundle agent (`config.yaml` + `AGENTS.md`) generated from one shared template
  (`infra/omnigent/templates/`) by `node infra/omnigent/render-agents.mjs`, so the two harness
  variants differ only in `executor.config.harness`/`model`. Tools are `web_search` and
  `web_fetch` builtins only for week 1. `AGENTS.md` just says to follow
  `<deployment_context>` — all the real per-turn instructions arrive through the context-provider
  hook.
- **Gateway** — `packages/adapters/src/omnigent/client.ts` (a small typed REST client:
  create/get sessions, post a message event, stream SSE, list items — no SDK, just `fetch` and a
  tiny SSE parser mirroring `apps/mobile/lib/api.ts`'s `subscribeThread`) and
  `packages/adapters/src/omnigent/gateway.ts` (`runTurnOnOmnigent`): gets or creates the Muse's
  Omnigent session (one per bot, id stored in the new `omnigent_sessions` table), posts the
  turn's message, waits for `response.completed`, and writes the final assistant text into the
  Nova thread with the same `ThreadEvents.finalizeRun` helper the existing engine uses — so the
  web app shows it like any other bot reply.
- **Flag** — `packages/adapters/src/background-job-handlers.ts`'s `"run.continue"` handler calls
  `runTurnOnOmnigent` first when `NOVA_ENGINE=omnigent`, falling back to
  `executor.continueRun` when the run isn't eligible (see "Eligibility" below) or when the flag
  is unset. Both `apps/worker` and `apps/api` (which also runs job handlers when
  `WAKEUP_DRIVER=memory`) wire this identically through
  `packages/adapters/src/omnigent/env.ts`'s `omnigentGatewayDepsFromEnv`.

### Eligibility (what actually runs on Omnigent)

Only a plain user message (`run.trigger === "user"`) on a Muse's own private Conversation thread
(`thread.botId === run.botId`, no `goalId`) is eligible. Routines, Goal-log turns, group chats,
and messaging-channel runs always use the existing engine, flag or no flag — Omnigent's side of
this integration doesn't cover those yet.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `NOVA_ENGINE` | `apps/api`, `apps/worker` | Set to `omnigent` to route eligible runs through the gateway. Unset (default) keeps the existing engine. |
| `OMNIGENT_URL` | `apps/api`, `apps/worker` | Base URL of the Omnigent server, e.g. `http://127.0.0.1:8000`. Required when `NOVA_ENGINE=omnigent`. |
| `OMNIGENT_PROXY_SECRET` | `apps/api`, `apps/worker` | Shared secret sent as `X-Omnigent-Proxy-Secret` on every gateway call, alongside `X-Forwarded-Email` (the person's email) for Omnigent's header-auth mode. Required when `NOVA_ENGINE=omnigent`. |
| `OMNIGENT_AGENT_NAME` | `apps/api`, `apps/worker` | Which built-in agent bundle to run turns on. Defaults to `nova-pi`; set to `nova-claude` to use the Claude Agent SDK harness instead. |
| `OMNIGENT_CONTEXT_PROVIDER_SECRET` | `apps/api` | Bearer secret the context-provider route requires. **Unset 404s the route entirely** — set this to enable the endpoint. |
| `NOVA_PI_MODEL` / `NOVA_CLAUDE_MODEL` | Omnigent server process | Model id substituted into the generated `nova-pi`/`nova-claude` bundles' `executor.config.model` (`${NOVA_PI_MODEL}` / `${NOVA_CLAUDE_MODEL}`). Omnigent expands `${VAR}` server-side for built-in agents loaded via `OMNIGENT_BUILTIN_AGENT_DIRS`. Use a model id valid for that harness's configured provider, e.g. a Databricks/Anthropic Claude model id. |

## Running Omnigent locally against Nova

From the repo root, with Nova's API running on `127.0.0.1:3100` (the default):

```bash
export OMNIGENT_CONTEXT_PROVIDER_URL=http://127.0.0.1:3100/internal/omnigent/context
export OMNIGENT_CONTEXT_PROVIDER_SECRET=some-long-random-dev-secret
export OMNIGENT_AUTH_HEADER_SECRET=some-long-random-dev-secret   # see Open Questions below
export OMNIGENT_BUILTIN_AGENT_DIRS="$(pwd)/infra/omnigent/agents/nova-pi:$(pwd)/infra/omnigent/agents/nova-claude"

uv run --project engine/omnigent omnigent server
```

(Docker-for-Nova / Omnigent-on-host: replace `127.0.0.1` in `OMNIGENT_CONTEXT_PROVIDER_URL` with
`host.docker.internal` so the container can reach Nova's API.)

Then, in Nova's own env (`apps/api` and `apps/worker`):

```bash
export NOVA_ENGINE=omnigent
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

Unset `NOVA_ENGINE` (or set it to anything other than `"omnigent"`) in `apps/api` and
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
  `GET /api/agents` by name the first time a bot talks to Omnigent, then remembers the session id
  from then on. If the built-in agent bundle is ever re-registered under a new id (e.g. after
  changing its `name`), existing bots will keep talking to the *session* they already created
  (unaffected) but a *new* bot's first turn would resolve whatever id currently answers to that
  name — should be fine as long as bundle names stay stable.
