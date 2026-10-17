# Engine trim tracker

`engine/omnigent` is a full copy of Omnigent: every harness, provider,
sandbox and deploy target it supports. Superchat uses a small part of it
(Claude SDK and Pi harnesses, `superside-chat`). This file tracks what we carry but
don't use, so it can be removed before production.

**How to use it**

- A feature starts needing something listed under **Candidates** → move its
  row to **Needed** and add one line saying which feature needs it.
- Before production, remove everything still under **Candidates** (code,
  tests, docs, dependencies), then run the engine and app test suites.
- Removing is done in small commits, one row at a time, so a mistake is easy
  to revert.

## Needed

| Part | Path | Needed by |
|---|---|---|
| Server, runner, host daemon | `omnigent/server`, `omnigent/runner`, `omnigent/host` | Everything |
| superside-chat | `omnigent/superchat`, `omnigent/context`, `rollover/` (docs) | Conversation, side chats, Helpers, Activity |
| Claude SDK engine | `omnigent/inner/claude_sdk_*`, `claude_gateway_shim.py` | Every turn (default harness) |
| Pi engine | `omnigent/inner/pi_executor.py`, `pi_harness.py`, `pi_settings.py` | `SUPERCHAT_MUSE_HARNESS=pi` (bundle `superchat-pi`) |
| Memory | `omnigent/memory`, `omnigent/server/memory_upkeep.py`, `session_memory.py` | Memory Profile, Upkeep |
| LLM client: Anthropic | `omnigent/llms/adapters/anthropic.py` | Rollover summaries, Upkeep |
| LLM client: OpenAI | `omnigent/llms/adapters/openai.py` | Memory search embeddings (`text-embedding-3-small`) |
| Stores, DB, migrations | `omnigent/stores`, `omnigent/db` | Everything |
| Header auth with shared secret | `omnigent/server/auth.py` | Superchat API → engine identity |
| Computer runner location | `omnigent/onboarding/sandboxes/{computer,base,registry,agent_sandbox,agent_sandbox_warm_pool}.py`, `server/managed_hosts.py` | Muse runner in its computer |
| Computer status | `omnigent/superchat/computer/routes.py` | Ready and launch status |
| Local browser backend | `omnigent/tools/browser_backend.py` | `browser_*` on the Computer's own screen |
| OS tools | `omnigent/inner/os_env.py` (`sys_os_*`) | The Muse acting on its Computer |
| Browser prompt instruction | `omnigent/runtime/prompt.py` | Steers the Muse to `browser_*` |
| Agent spec / bundles | `omnigent/spec` | `deployment/engine/agents/superchat-claude` |
| Built-in tools in use | `omnigent/tools` (`session_history`, `memory_*`, `side_chat_open`, `sys_session_*`) | The Muse and Helpers |
| Example bundle | `examples/super-chat` | Reference for `deployment/engine/agents/superchat-claude` |

## Candidates

### Engines (harnesses) other than Claude SDK

| Part | Path | Why we likely don't need it |
|---|---|---|
| Native CLI harnesses (claude, codex, pi-native, cursor, devin, goose, hermes, kimi, kiro, opencode, qwen, antigravity) | `omnigent/harnesses/*_native`, `omnigent/inner/*_native_*`, `omnigent/native`, `omnigent/cli_native.py` | Superchat runs Claude SDK and Pi only |
| Other SDK harnesses (codex, openai-agents, antigravity, copilot, cursor, databricks, goose, hermes, kimi, qwen) | `omnigent/inner/{codex,openai_agents_sdk,antigravity,copilot,cursor,databricks,goose,hermes,kimi,qwen}_*` | Same |
| ACP harnesses | `omnigent/inner/acp_*`, `omnigent/acp_cli_harnesses.py` | Same |
| Native-CLI rollover mode (`omnigent.context.mode=rollover`) | parts of `omnigent/context/rollover.py`, `runner/native/orchestration.py`, `rollover/README.md` | Only `superside-chat` is used |
| Harness install/availability/plugins | `omnigent/harness_*.py`, `omnigent/install_ledger.py` | One fixed engine |

### Model providers and routing

| Part | Path | Why |
|---|---|---|
| Bedrock, Vertex, Gemini, Databricks LLM adapters | `omnigent/llms/adapters/{bedrock,vertex,gemini,databricks}.py` | Anthropic + OpenAI only |
| Databricks AI gateway, tokens | `omnigent/databricks_ai_gateway.py`, `omnigent/inner/databricks_token.py` | Not used |
| Smart routing | `omnigent/smart_routing_cli.py`, routing parts of `omnigent/runner` | One model per bundle |
| Model signing / egress / credential proxy | `omnigent/inner/model_sign*`, `model_egress.py`, `credential_proxy.py` | Check before removing: may be needed for the computer runner |

### Sandboxes and deploy targets

| Part | Path | Why |
|---|---|---|
| Third-party sandbox providers (blaxel, boxlite, cwsandbox, daytona, e2b, gensee, islo, kubernetes, microsandbox, modal, openshell) | `omnigent/onboarding/sandboxes/*.py` (not `computer`, `base`, `registry`, `agent_sandbox*`) | Superchat uses its computer |
| Local OS sandboxes (bwrap, seatbelt, Windows job object, seccomp) | `omnigent/inner/{bwrap,seatbelt,windows_jobobject}_sandbox.py`, `_seccomp.py` | Check: may be used by the computer runner |
| Deploy recipes (blaxel, boxlite, cloudflare, cockroachdb, databricks, daytona, e2b, fly, gensee, hf-spaces, islo, kubernetes, microsandbox, modal, openshell, railway, render, tailscale) | `deploy/*`, `railway.toml`, `render.yaml` | Superchat deploys with its own `infra/` |

### Clients and surfaces Superchat replaces

| Part | Path | Why |
|---|---|---|
| Omnigent web app | `web/` | Superchat has its own app |
| Terminal REPL, pickers, conversation browser | `omnigent/repl`, `omnigent/terminals`, `omnigent/conversation_browser.py`, `omnigent/_terminal_picker_theme.py` | No terminal UI in Superchat |
| CLI onboarding and setup | `omnigent/onboarding` (except sandboxes in use), `omnigent/cli_*.py` | Check: the host daemon still starts from the CLI |
| Editor and chat integrations | `editors/vscode`, `integrations/slack`, `omnigent/integration_daemon.py` | Not used |
| Client SDKs | `sdks/` | Superchat calls the HTTP API directly |
| Session import | `omnigent/session_import` | Not used |

### Tools Superchat doesn't use

| Part | Path | Why |
|---|---|---|
| Desktop-app browser relay | `runner/tool_dispatch.py` `_execute_browser_tool` relay path, `server/routes/sessions/routes_browser.py` | Superchat uses the local backend. Candidate, but kept: generic, and the default when the variable is unset |
| `web_fetch` and its sandboxed web-research sub-agent | `omnigent/tools/builtins/web_fetch.py`, `__web_researcher` dispatch in `omnigent/runner/tool_dispatch.py` | Web search calls Tavily directly |
| Other web search backends (OpenAI native, Perplexity, Nimble, DuckDuckGo, …) | `omnigent/tools/builtins/web_search*.py` except `web_search_tavily.py` | Tavily only |

### Examples, docs and tooling

| Part | Path | Why |
|---|---|---|
| Example agents | `examples/{aws_analyst,debby,deep-research,extensions,kimi_hello.yaml,polly,remy,scribe,sentinel}` | Only `super-chat` is a reference |
| Policies examples (nessie) | `omnigent/inner/nessie` | Not used |
| Design docs, feature map, stray mockup | `designs/`, `feature-map/`, `muse-clone.html` | Upstream material |
| Upstream skills | `engine/omnigent/.claude/skills/*` (harness e2e, polly, load test) | For harnesses we don't run |
| Load test, benchmarks | `dev/loadtest`, `dev/benchmarks` | Keep only if we load-test |

## Removed

| Part | When | Commit |
|---|---|---|
| Superchat's own engine package `omnigent/superchat` (notes memory, feed, episodes, goals, asks, skills, context provider) | 2026-10-03 | `bfe6886e` (replaced by superside-chat) |
| Omnigent's web app, deploy recipes, docs, designs, feature map, editors, Slack integration, dev tools, example agents other than `super-chat`, release scripts, pnpm workspace | 2026-10-16 | engine-only: groups A and B of `engine-axe-list.md` |
| `infra/` and `scripts/` (moved into `deployment/`; old Dockerfiles, compose overlay and Railway config deleted) | 2026-10-16 | same |
| `web_search` and its Tavily backend (no bundle enabled it and no deployment passed the key) | 2026-10-16 | web search returns later as its own capability |
| Databricks: gateway, credential helper, executor, app, identity, model discovery, volumes store, login and configure branches; with them `onboarding/setup.py`, `ucode_setup.py`, `ucode_cleanup.py`, `runtime/credentials`, `inner/claude_gateway_shim.py` (28,711 lines) | 2026-10-16 | `dcc017c00`, ADR 0020 |
| CockroachDB dialect branches, `db/cockroachdb.py`, the CRDB DDL lock in `tests/db/conftest.py` (1,218 lines) | 2026-10-16 | `5a850efda`, ADR 0020 |
| macOS seatbelt and Windows job-object sandboxes, `sandbox/bwrap.py` (unreachable); `_default_sandbox_for_platform()` is always `linux_bwrap` (5,972 lines) | 2026-10-16 | `c7a18240d`, ADR 0020 |
| Dead harness and provider strings (OpenAI agents, ACP, OpenCode, Cursor, Goose, Kiro, Hermes, Qwen, Antigravity, `GEMINI_API_KEY` forwarding; Gemini stays as a model vendor a gateway can serve) and the `uv.toml` exemptions (245 lines) | 2026-10-16 | `13fa2cf9a`, ADR 0020 |
| Legacy CLI: `cli.py` cut from 11,545 to 1,797 lines (root group, `host` group and its six subcommands, `main`); `repl/`, `chat.py`, `update_check`, `crash_*`, `install_ledger`, `cli_diagnostics`, `resume_dispatch`, `integration_daemon`, `client_tools/`, `session_import`, `_env_compat`, `cli_invocation`, `conversation_browser`, `_terminal_picker_theme`, `cli_config`, `diagnostics.py`, `_runner_startup.py`, `onboarding/sandboxes/bootstrap.py`, `host/local_server.py`, `host/_daemon_entry.py`, `runner/repl_terminal.py` (the REPL terminal auto-launched beside every session), the `omni` alias; Databricks follow-ups: copy-on-write sandbox, UC function tools, MCP `databricks_profile`, `databricks_cli` credential proxy, `kind: databricks` provider, router Databricks auth, Lakebase refresh, `ucode_state`, `databricks-sdk` extra; Codex follow-ups: onboarding detection and install, `codex_auth_readiness`, `configure_models`, `interactive`, `codex_model_vocabulary`, `CODEX_ACCESS_TOKEN` forwarding. Routing helpers now `server/routing_settings.py` (106,926 lines) | 2026-10-17 | `34183c66b`..`4c3719384`, merge `7a3f7c1f0`, ADR 0020 |
| Web: side chats and forks. `features/side-chats`, the Chats popover (side chats, forks, archive), the fork action and thread, the old sidebar, "Chat with this folder", the auto-archive setting, `rpc/side-chats.ts` (now `rpc/chats.ts` with transcript, send, interrupt, project, setFolder), the `fork_summary` block, `ThreadMessage.forks`, `ThreadMessagePage.lineage`, the `fork-*` tokens. Conversation components moved back under `pages/app/conversation` (9,969 lines) | 2026-10-17 | `e81b4e92a`..`3d58abbbd`, ADR 0021 |
| Native harness cluster: `harnesses/codex_native`, `harnesses/claude_native`, `harnesses/pi_native` (credentials kept as `inner/pi_credentials.py`), `omnigent/native`, `runner/native`, `runner/turn_routing.py`, native terminal pieces, `server/routes/imports.py`, native branches in `runner/app.py`, `server/routes/_sessions/helpers.py`, `cli.py`, `host/connect.py`, `host/frames.py`, root `tests/e2e_ui`. `omnigent/terminals` core kept for `sys_terminal` and terminal attach (398,338 lines) | 2026-10-17 | `a1cb978fb`..`7e1a4e7f5`, ADR 0020 |
| Web: `packages/charts`, the `*.chart.json` / `*.dashboard.json` renderers, chart cards and thumbnails, the canvas block and `ui-web/canvas`, Observable Plot, the `chart` and `canvas` message blocks, dead event kinds (`app_connect`, `child_bot`, `choice`, `computer`, `connect`), `bot-secrets`, `cron`, `avatar-motion`, `AuroraBackground`, `ConversationHeader`, transcript grouping, chart and canvas dev previews, turbo and stale ignore entries. Old transcripts show "This chart was made with an older version"; `*.dashboard.html` pages stay (14,020 lines) | 2026-10-16 | `1bc32b5ca`..`88bf660fe`, ADR 0020 |

## Follow-ups from the web cut

- Host folder (2026-10-17, `38eb06fc0`, `df9118488`): `deployment/computer/*` is `host/bin`, `host/share`, `host/tests` (ADR 0019). Image, service and Dockerfile names unchanged until the Computer → host rename wave. `host/tests/test_dashboard.py` needs pandas, which the engine venv lacks; the CI Python job must install the host test extras or run it in the host image.

- Web move (2026-10-17, `edda299ee`, `100d359bd`): `apps/web` is `web/app`, `packages` is `web/packages` (ADR 0019). Package names unchanged. Root `NOTICE` still names paths that no longer exist (`infra/sandboxes`, `features/decks/edit/bridge.js`); rewrite it in the docs wave.

- Web structure pass (2026-10-17, `241f34937`..`bcb7e66f9`): features no longer import from pages; `pages/muse` is `pages/app`; CSS prefix `rk-` is `sc-`. Two seams remain: `lib/useMuseLiveState` composes `features/approvals` and `features/computer`, and `components/conversation` imports features because the fork thread renders the message bubble. Both resolve when side chats and forks go (ADR 0021).
- `web/packages/chat-ui` `markdown.test.ts` fails on a dropped React Native markdown package; delete the test or the native code path with it.

- Root `NOTICE` still credits the nao-derived chart code that no longer exists; trim the entry.
- `pnpm check` fails on a pre-existing error in `web/packages/adapters` (`BodyInit` not found in `src/omnigent/artifacts.ts`); CI's web job has been red on it since before the cut. Fix with the CI work in wave 5.
- `tool-presentation.completeness.test.ts` fails because the `superchat-claude` bundle declares no `builtins`; decide whether the test or the bundle is right in wave 5.

## Follow-ups from the legacy CLI cut

- `tests/e2e`, `tests/_helpers/live_server.py` and the 49 test files that spawn `omnigent server` run a command that no longer exists. Delete them with the engine side-chat cut; the Superchat smoke test against the compose stack replaces them (ADR 0019 CI job).
- `cli_auth.py` stays as the runner and host server-client factory; its Databricks org-id and slice-key headers and the `databricks_request_headers` name are dead weight to rename and trim in the flatten wave.
- Smart routing tables (`model_fallbacks`, `pi_model_compatibility`, `model_override`, `AUTO_NATIVE_ROUTING_HARNESSES`, `_COUNTERPART_HARNESS`) still carry Codex and native names; cutting them changes routing candidates and needs its own record.
- `sdks/ui` (`omnigent_ui_sdk`) is unused by the engine; the Dockerfiles still install it. Remove with the flatten wave. `sdks/python-client` is still imported by `tools/local.py`.
- `server/schemas.py` keeps native wire fields the web contract names; cut them together with the web contract.

## Follow-ups from the web side-chat cut

- Engine half of ADR 0021 still to cut: `superchat/side_chats`, the `superside-chat` seed plumbing in `context/labels.py` and `context/rollover.py`, the `side_chat_open` tool, the side-chat archiving job. Web keeps the `side_chat` activity source and the `side_chat_open` tool title until then.
- `SuperchatGlyphs` exports four glyphs nothing uses now (`ConversationGlyph`, `WaitingGlyph`, `SettingsGlyph`, `SidebarGlyph`).

## Follow-ups from the native cut

- Codex SDK-family vocabulary remains in onboarding (`ambient`, `provider_config`, `harness_install`, `configure_models`, `detected`, `codex_auth_readiness`, `ucode_state`), models (`codex_model_vocabulary`, `model_catalog`, `model_override`, `model_fallbacks`), `runtime/workflow.py`, `cli_config.py`, `server/smart_routing.py`, `server/schemas.py`, `runner/subagent_routing.py`, `host/frames.py`; `inner/hook_scripts/subagent_router.py` still names `codex-native`; `CODEX_ACCESS_TOKEN` is still forwarded in `host/connect.py`. Cut with the legacy CLI.
- `chat.py` imports the deleted `databricks_executor`; it goes with the legacy CLI.
- Tests needing `asgiref` or `opentelemetry.sdk` fail to collect in the engine venv; the CI Python job must install the `dev` extras.

## Follow-ups from the Databricks cut

- Still reference Databricks and are on the legacy-CLI cut list: `cli_auth.py`, the fronted-server detection in `cli.py`, `server/smart_routing.py` (`databricks_profile`, ambient SDK auth), `inner/credential_proxy.py`, `runner/uc_function.py`, `tools/mcp.py` `databricks_profile`, Lakebase token refresh in `db/utils.py`, the routing tables in `models/model_fallbacks.py`, `pi_model_compatibility.py`, `model_override.py`, `ucode_state.py`, the `kind: databricks` schema in `spec/types.py`, `spec/parser.py` and `provider_config.py`.
- `sandbox/copy_on_write.py` only ever accepted the removed OpenAI-agents harness; its gate now rejects every harness. Delete the feature whole with its `inner/os_env.py` import.
- The executors' `gateway=True` path is NOT Databricks-only: `runtime/workflow.py` sets it for every `kind: gateway` provider, which the deployment config templates use for LiteLLM. Kept. (Corrected 2026-10-17.)
- `databricks-sdk` stays in the `all` extra until the references above are gone; `uv.lock` was already stale before the cut.
