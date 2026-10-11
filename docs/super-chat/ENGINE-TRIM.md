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
| Agent spec / bundles | `omnigent/spec` | `infra/omnigent/agents/superchat-claude` |
| Built-in tools in use | `omnigent/tools` (`web_search` with the Tavily backend, `session_history`, `memory_*`, `side_chat_open`, `sys_session_*`) | The Muse and Helpers |
| Example bundle | `examples/super-chat` | Reference for `infra/omnigent/agents/superchat-claude` |

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
