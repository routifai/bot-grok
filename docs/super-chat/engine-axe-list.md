# Engine axe list

What `engine/omnigent` and the repo carry that Superchat does not run, grouped by how it can go.
Written 2026-10-15 from an import graph of the package (static imports, imports inside functions,
and the string tables the plugin registries load by name) plus the Dockerfiles, Compose files and
CI. S3 stays (artifact store in S3/R2). `ENGINE-TRIM.md` is the running tracker; this list is the
one-time cut.

What Superchat runs: the server (`omnigent/server`, `api`, `superchat`), the runner and host daemon
(`omnigent/runner`, `host`), the two harnesses (`inner/claude_sdk_*`, `inner/pi_*`,
`harnesses/pi_native`), stores and migrations, memory, context, the Computer sandbox provider
(`onboarding/sandboxes/{computer,base,registry,types,bootstrap,agent_sandbox*}`), and
`omnigent/cli.py` with the modules it imports at load time (the Computer is started with
`omnigent host`, a CLI command).

## A. Delete now, no code change (done 2026-10-16)

| Path | What it is | Size |
|---|---|---|
| `engine/omnigent/deploy/` except `docker/entrypoint.py` | deploy recipes for 19 platforms, Omnigent's Dockerfile, compose, Caddy, UBI | 101 files |
| `engine/omnigent/docs/` | Omnigent's docs | 12 MB |
| `engine/omnigent/designs/`, `feature-map/` | Omnigent design notes | 35 files |
| `engine/omnigent/editors/` | VS Code extension | 33 files |
| `engine/omnigent/integrations/` | Slack integration (`slack` extra) | 61 files |
| `engine/omnigent/dev/` | load tests, benchmarks, repro tools | 109 files |
| `engine/omnigent/examples/` except `super-chat` | example agents (`resources/examples/{polly,debby}` symlinks go with them) | |
| `engine/omnigent/scripts/` | release and version tooling (`dump_openapi.py` only if `openapi.json` is regenerated) | 13 files |
| `engine/omnigent/sdks/web-extension/` | TypeScript SDK for Omnigent web extensions | |
| `engine/omnigent/muse-clone.html`, `railway.toml`, `render.yaml`, `justfile`, `.pre-commit-config.yaml`, `pyrefly.toml`, `.github/`, `.claude/`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `README.md` | Omnigent's own tooling and docs | |
| `engine/omnigent/build/`, `data/`, `omnigent.egg-info/`, `.venv`, caches | local output, untracked | 54 MB |
| `engine/omnigent/tests/` outside `tests/superchat` and tests of kept modules | harness, REPL, e2e UI, parity suites | most of 2,758 files |

## B. Delete with `deployment/` in place (done 2026-10-16)

`deployment/engine.Dockerfile` and `computer.Dockerfile` build from sources and never touch these.

| Path | What it is |
|---|---|
| `engine/omnigent/web/` | Omnigent's web app and Electron shell; built into every engine image today, never served (1,443 files, 22 MB) |
| `engine/omnigent/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `node_modules/` | the pnpm workspace that only `web/` needed |
| `engine/omnigent/omnigent/server/static/web-ui/` | the built copy of that web app inside the package (untracked) |
| `deployment/engine.Dockerfile`, `Dockerfile.dockerignore` | the old engine image (FROM Omnigent's server image) |
| `deployment/computer.Dockerfile`, `ubuntu-python.Dockerfile` | the old Computer image (FROM Omnigent's host image) |
| `deployment/compose.yaml` | the overlay on Omnigent's compose file |
| `infra/railway/` | Railway config: pulls `ghcr.io/omnigent-ai/omnigent-server:latest` (upstream Omnigent, no Superchat in it) and Railway has no Docker socket for the Computers; cannot work as written |
| `deployment/computer/supervisor/` | only a `node_modules/` left from the removed supervisor |

The inputs moved into `deployment/` (`engine/`, `computer/`, `postgres/`, `entrypoint.py`, the three scripts).

## C. Delete after trimming a registry table

Reached only through a string table; remove the row, then the module.

| Path | Table to trim |
|---|---|
| `omnigent/onboarding/sandboxes/{blaxel,boxlite,cwsandbox,daytona,e2b,gensee,islo,kubernetes,microsandbox,modal,openshell}.py` | `onboarding/sandboxes/registry.py`, `server/managed_hosts.py` |
| `omnigent/harnesses/{antigravity,cursor,devin,goose,hermes,qwen}_native/` | `harness_plugins.py` (the name → module map) |
| `omnigent/inner/{acp_*, _acp_omnigent_mcp, antigravity_*, codex_*, copilot_*, cursor_*, devin_*, goose_*, hermes_*, kimi_*, kiro_*, openai_agents_sdk_*, open_responses_sdk, opencode_*, pi_native_*, qwen_*}`, `cursor_policy_hook`, `hermes_policy_hook`, `hook_scripts/{claude_router_hook,codex_router_hook}`, `databricks_*`, `nessie/` | `harness_plugins.py`, `policies/builtins` |
| `omnigent/tools/builtins/{web_fetch*, web_search_{duckduckgo,google,keenable,nimble,perplexity}, nimble_*, hindsight, export_agent}` | `tools/__init__.py` tool registry |
| `omnigent/llms/adapters/{bedrock,vertex,gemini,databricks}.py` | `llms/adapters/__init__.py` |
| `omnigent/runner/github_resource.py`, `pr_observer.py` | the GitHub side panel; Superchat has none, and the Computer image no longer installs `gh` |
| `pyproject.toml` extras for the above (`bedrock`, `vertex`, `modal`, `daytona`, `blaxel`, `boxlite`, `microsandbox`, `cwsandbox`, `e2b`, `islo`, `openshell`, `kubernetes`, `vault`, `antigravity`, `copilot`, `cursor`, `hindsight`, `nimble`, `slack`, `databricks`, `loadtest`, `cockroachdb`, `dictation`, `tracing`) | keep `memory`, `postgres`, `s3`, `kms` |

## D. Unused, no imports at all

`__main__.py`, `crash_handler.py`, `crash_ui.py`, `diagnostics.py`, `smart_routing_cli.py`,
`environments/`, `community/`, `testing/`, `_e2e_policy_callables.py`,
`onboarding/{agent/, goose_auth, hermes_auth, openclaw_config, provider_selection, ucode_cleanup}`.

## E. Entangled: unused features imported at load time by code that runs

Each needs its import site changed first. Do these last, one at a time.

| Path | Imported by |
|---|---|
| `harnesses/{claude_native,codex_native,kimi_native,kiro_native,opencode_native}` | `host/daemon_launch` (claude_native.bridge), `server/routes/sessions` (codex_native.elicitation), `onboarding/harness_readiness` (kimi_native), `onboarding/harness_install` (opencode_native) |
| `onboarding/` outside `sandboxes` | `host/connect` → `harness_readiness` → `*_auth`; `runtime/workflow` → `detected` |
| `native/`, `terminals/`, `session_import/`, `conversation_browser.py`, `acp_cli_harnesses.py`, `codex_approval_modes.py`, `databricks_ai_gateway.py`, `connections/`, `server/{databricks_*,github_app*}` | `server/app`, `inner/terminal`, `entities/session_resources`, `stores/conversation_store`, `harnesses/pi_native/main`, `harness_plugins`, `server/routes/_sessions/helpers`, `claude_sdk_executor`, `entrypoint.py` |
| `repl/`, `chat.py`, `cli_auth.py`, `client_tools/`, `claude_launcher.py`, `resume_dispatch.py`, `git_credential_github.py`, `update_check.py`, `install_ledger.py`, `cli_diagnostics.py`, `_terminal_picker_theme.py` | lazy calls from `cli.py` and `host/connect`; `sdks/ui` exists only for `repl/` |
| `inner/{banner,mascots,wordmark,ui,loader}` | `cli.py` at load time |

Check before touching: `inner/{bwrap_sandbox,seatbelt_sandbox,windows_jobobject_sandbox,_seccomp}` and
`omnigent/sandbox/` (the runner's default Linux sandbox is bwrap and fails loud without it), and
`inner/{model_sign*,model_egress,credential_proxy}` (model calls from the Computer).

## F. Our own leftovers

| Path | Verdict |
|---|---|
| `SETUP_PROMPT.md`, `VISION.md` | referenced nowhere; stale or move to `docs/` |
| `PRODUCT_PLAN.md` lines in `.dockerignore`, `.gitignore` | the file does not exist |
| `skills-lock.json` | agent tooling lock, not product |
| `deployment/computer/__pycache__/` | untracked |
| `data/` (repo root) | local engine data, gitignored |

## Keep

| Path | Why |
|---|---|
| `omnigent/stores/artifact_store/s3.py` and the `s3` extra | artifacts in S3/R2 (`OMNIGENT_ARTIFACT_URI=s3://…`); the new engine image installs the extra |
| `stores/credential_store/secret_cipher.py` and the `kms` extra | AWS KMS cipher for saved keys, optional |
| `sdks/python-client`, `sdks/ui` | hard dependencies of the package (`ui` can go with `repl/`) |
| `examples/super-chat` | the reference `deployment/engine/agents/*/config.yaml` cites |
| `rollover/` | design docs cited by the bundles |
| `openapi.json` | the source `packages/adapters` is generated from |
| `omnigent/memory` and the `memory` extra | the Memory service (txtai index); the reason torch is in the image |
