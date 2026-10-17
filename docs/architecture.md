# Architecture

How Superchat is put together, as of 2026-10-17. Words are defined in [glossary.md](glossary.md);
where each piece of code lives is the layer map in [`engine/README.md`](../engine/README.md).

Superchat gives each person one persistent assistant that keeps their conversation, memory and
files over time, works in the background on its own machine, and comes back when it has a result
or needs them. It runs entirely on infrastructure its operator controls: models, memory and the
per-person machine are configured, not rented from a fixed vendor.

## The three processes and the request path

| Process | Where | What |
|---|---|---|
| web | the browser | the UI in `web/app`, built into the engine image and served by the engine |
| engine | the `engine` container | one Python process (`omnigent`): the API, the built web, Postgres, sessions, scheduling, the model proxy; starts hosts over the Docker socket |
| host | one Docker container per person today | runs `omnigent host`, which launches one runner per session; each runner runs one harness |

A message travels:

```
web ──HTTP /v1 + SSE──▶ engine ──host tunnel (WebSocket)──▶ host ──spawns──▶ runner ──▶ harness (claude-sdk | pi)
                          ▲                                                    │
                          └──────────── runner tunnel (WebSocket) ◀────────────┘
```

1. The web posts the message to `POST /v1/sessions/{id}/events` and listens on
   `GET /v1/sessions/{id}/family/stream`, one SSE stream for the conversation and its helpers. Its
   events carry ids only; the web refetches what changed (`GET /v1/sessions/{id}/transcript`).
2. The engine stores the item and hands the turn to the session's runner. If the person's host is
   not up, the engine launches it first (see [The host lifecycle](#the-host-lifecycle)).
3. The host, dialled in on `/v1/hosts/{host_id}/tunnel`, receives a launch frame and starts a
   runner, which dials back on `/v1/runners/{runner_id}/tunnel`.
4. The runner builds the turn (the per-turn prefix, see [context.md](context.md)), runs the harness,
   and dispatches Superchat tools to their feature handlers (`runner/tool_dispatch.py`). Tool calls
   that need the database go back to the engine over HTTP.
5. The harness's model calls go to the engine's model proxy, never straight to a provider when the
   key must stay in the engine ([Models and keys](#models-and-keys)).

There is no app server between the web and the engine
([ADR 0015](adr/0015-no-app-server-the-web-talks-to-the-engine.md)). The engine is the whole
backend and returns codes and data, never English copy, so any website could drive it
([ADR 0009](adr/0009-the-engine-is-the-whole-backend.md)). The harness only runs the model loop:
helpers, memory, rollover and activity are engine features, never harness features
([ADR 0006](adr/0006-omnigent-owns-everything.md)).

A message sent while a turn runs is a steer: `claude-sdk` receives it on the CLI's input at
priority `next`, `pi` through its RPC `steer`. Anything the harness did not take runs as the next
turn, so nothing is lost or answered twice.

## Sessions and helpers

Everything is a session in Postgres. Two kinds matter:

- **The conversation.** One per person and tenant, found or created by `GET /v1/me/muse`
  (`superchat/muse.py`). Its id is derived from a hash of the person and tenant, so two first calls
  land on one row. It carries the label `omnigent.context.mode=superside-chat`, which turns on the
  Superchat tools, and `omnigent.host.owner`, which picks the host. The agent bundle it runs is
  `OMNIGENT_SUPERCHAT_DEFAULT_AGENT` (`superchat-claude` by default, `superchat-pi` for Pi).
  `POST /v1/sessions/{id}/reset` clears it; the old items stay stored.
- **Helpers.** Child sessions the assistant starts with `start_helper` for one bounded job. They
  run in the same host, report back to the chat that started them, and are read-only to the
  person. Types, limits and the wake path are in [helpers.md](helpers.md).

The conversation, its helpers and messages linking to artifacts are specified in
[conversation.md](conversation.md).

Each capability is a feature folder under `engine/omnigent/superchat/` with a `FEATURE`, registered
once in `superchat/features.py`; the tool manager, the runner's dispatch and the app read that list.

## Where the system prompt lives

The assistant's prompt and the helper types are edited in `engine/agents/templates/` and rendered
by `node engine/agents/render-agents.mjs` into the committed bundles under `engine/agents/bundles/`.
Details and the drift test are in the "Where is" table of [`engine/README.md`](../engine/README.md).
What is added to each turn on top of the prompt is in [context.md](context.md).

## The host lifecycle

The host provider is `docker` (`engine/omnigent/hosts/docker.py`), configured by the server
config's `host:` block; the engine's side is `engine/omnigent/server/hosts.py`.

- **Launch.** The first turn of a session with no live host makes the engine provision the
  person's container through the Docker Engine API: `superchat-host-<key>` from
  `OMNIGENT_HOST_IMAGE`, home on the volume `superchat-home-<key>` mounted at
  `/home/superchat`, all capabilities dropped, `no-new-privileges`, the memory, CPU and pid limits
  from the env file, restart policy `unless-stopped`. An existing container is reused (started if
  stopped) and recreated only when the image changed; the home volume survives a recreate. The
  engine then starts `omnigent host` inside it through `docker exec`, wrapped in a restart-on-crash
  loop.
- **Launch token.** The engine mints a launch token per launch and stores only its digest and
  expiry. The host uses it to authenticate its tunnel, and the harness uses `<host_id>:<token>` as
  its credential at the model proxy. The token lives 7 days (`HOST_TOKEN_TTL_S`); a
  relaunch mints a new one. The person's own credentials never enter the host.
- **Registration.** A launch waits up to 120 seconds for the host to register
  (`HOST_ONLINE_TIMEOUT_S`); a message that arrives during a launch waits up to 240 seconds
  for it to settle.
- **Tunnel ping and liveness.** The engine pings each host and runner tunnel every 30 seconds and
  drops one after 3 missed pings. Liveness is a database stamp refreshed on that ping and read as
  stale after 90 seconds (`HOST_LIVENESS_TTL_S`, `RUNNER_LIVENESS_TTL_S`), so a crashed host or a
  silent network drop reads as offline without anyone calling disconnect. Socket-level keepalive
  pings every 30 seconds with a 90 second timeout.
- **No terminate.** The provider deliberately has no terminate or keep-alive: the host outlives
  any one session.

`GET /v1/sessions/{id}/host` answers `{ready, launch}`: whether the conversation's runner is
connected, and the launch stage while one is in flight or failed.

A runner sees only an allowlist of process variables plus the names listed in the server config's
`host.runner_env`, resolved from the engine's environment at launch and passed to the
`docker exec` call (never into a command string). The host has no outbound network filter today.

## Models and keys

`deployment/engine/start.sh` renders one of three templates from `deployment/engine/` into the
engine config. None names a model: the pickers list what the connection serves, and each person has
a **Default** and a **Light** pick per harness (`superchat/models/tiers.py`), chosen automatically
until they pick in **Settings > Models**. Background work runs on Light; a helper's `fast` runs on
Light and `strong` on Default.

| Template | Selected when | Where the key lives |
|---|---|---|
| `config.yaml.tmpl` | default (no `LITELLM_BASE_URL`) | the operator's `ANTHROPIC_API_KEY` (and `OPENROUTER_API_KEY`) are in `runner_env`, so they reach the host and are readable there |
| `config.litellm.yaml.tmpl` | `LITELLM_BASE_URL` is set | the engine only: harnesses call `/v1/model/litellm` with their launch token and the engine adds `LITELLM_API_KEY` (a person's or organisation's saved LiteLLM key wins) |
| `config.byok.yaml.tmpl` | `ENGINE_CONFIG_TEMPLATE` points at it | the engine only: each person saves their own key, sealed with `OMNIGENT_VAULT_KEY`; a person without one gets `model_key_required` |

The model proxy is `/v1/model/{provider}/{path}` (`superchat/models/proxy.py`). It resolves the
launch token to the host and its owner, strips whatever auth the caller sent, injects the owner's
key (their own first, else the organisation's), refuses a suspended owner or an exhausted budget,
and records the call's cost. The upstreams it knows are `anthropic`, `openrouter` and `litellm`
(`superchat/models/upstreams.py`). Saved keys are per person or per organisation, sealed with
AES-256-GCM (`superchat/models/store.py`). Operator setup is in [setup.md](setup.md#secrets).

## What is intentionally not there

The engine keeps only what Superchat runs: two harnesses (`claude-sdk`, `pi`), one host provider,
Postgres, Linux. Other harnesses, sandboxes, databases, the terminal REPL and Omnigent's own web
app were cut ([ADR 0020](adr/0020-the-engine-keeps-only-what-superchat-runs.md)); each removal is in
[engine-trim.md](engine-trim.md). Side chats and forks are gone
([ADR 0021](adr/0021-one-conversation-messages-link-to-artifacts.md)). Adding any of these back is a
feature with its own record, not a flag.
