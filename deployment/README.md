# Deployment

Superchat runs as three things on one Docker host:

| What | Image | Role |
|---|---|---|
| Postgres | `postgres:16-alpine` | one database, schema `engine` |
| Engine | `superchat/engine` (`engine.Dockerfile`) | the API, the web app and the published mini apps, in one container; starts the Computers over the Docker socket |
| Computer | `superchat/computer` (`computer.Dockerfile`) | one container per person; the runner, the model CLIs and the person's files live here |

The browser talks only to the engine. Each Computer's runner dials the engine back over a
WebSocket tunnel. There is no other service.

This folder is the whole deployment. Both images build from the repo's sources; nothing in
`engine/` is a Dockerfile, a deploy recipe or a web app any more.

## Build

From the repo root:

```sh
deployment/build.sh                 # superchat/engine:local and superchat/computer:local
deployment/build.sh engine          # one image
```

Behind a company firewall, point the mirrors and the CA at the build (`PYPI_INDEX_URL`,
`NPM_CONFIG_REGISTRY`, `NODE_IMAGE`, `PYTHON_IMAGE`, `UBUNTU_IMAGE`, `CHROMIUM_IMAGE`,
`TORCH_INDEX_URL`, `CA_BUNDLE=/path/ca.pem`); the script passes each one that is set. Multi-arch
and push: `IMAGE_REGISTRY=ghcr.io/acme IMAGE_TAG=v1.4.0 PLATFORM=linux/amd64,linux/arm64 PUSH=1`.

## Run

```sh
cp .env.docker.example .env        # fill POSTGRES_PASSWORD, OMNIGENT_PROXY_SECRET, OMNIGENT_VAULT_KEY, a model key
docker compose --env-file .env -f deployment/compose.yaml up -d --wait
open http://127.0.0.1:5173
```

The engine serves the web on `SUPERCHAT_WEB_PORT` (5173) and the API on `SUPERCHAT_ENGINE_PORT`
(8012). The Computers reach the engine at `ENGINE_PUBLIC_URL`; on native Linux set it to the Docker
bridge address and `SUPERCHAT_ENGINE_BIND` to match. Stop with `down`; `down -v` deletes all data.

For several people, put an SSO broker (an authenticating reverse proxy) in front of the engine,
set `OMNIGENT_LOCAL_SINGLE_USER=0`, and have the broker send the identity header with
`X-Omnigent-Proxy-Secret` equal to `OMNIGENT_PROXY_SECRET`. The engine honours the identity header
only with that secret.

## What each image contains, and why

### `engine.Dockerfile`

| Stage | Does | Why |
|---|---|---|
| `web` | `pnpm install` and `vite build` of `web/app` | the engine serves this build at `/`; the engine image is the only artifact to ship |
| `python` | installs `engine/omnigent` into `/opt/venv` with extras `memory,postgres,s3`, torch from the CPU index first | memory needs torch (through txtai); the CPU wheel is a few hundred MB, PyPI's Linux wheel carries CUDA |
| `engine` | `python:3.12-slim` + venv + web build + `/opt/bundle` (agent bundles, config templates, `start.sh`) + `entrypoint.py` | runtime has no compilers, no Node; `start.sh` renders the config from the environment and runs the entrypoint |

### `computer.Dockerfile`

| Stage | Does | Why |
|---|---|---|
| `chromium` | copies Chromium alone out of Playwright's pinned image | deck and dashboard export and the browser tools need a browser; nothing else from Playwright |
| `node` | pins Node 22 by image digest | the claude and pi CLIs are npm packages |
| `venv` | installs `engine/omnigent` (its runner half is what runs here) on the same Ubuntu as the runtime | a venv built on one distro and copied to another breaks interpreter paths |
| `computer` | `ubuntu:24.04` + the system packages the runner and the model's shell use + the data stack + Chromium + the pptx runtime + the two CLIs + the venv + the `host/` helpers and assets; user `superchat` (uid 1000) | the model works in a plain Ubuntu with Python; everything it can call is pinned here |

PID 1 is `superchat-computer`, which only keeps the container alive; the runner and every tool
arrive through `docker exec` from the engine.

## Production

Any Docker host runs the Compose file above: a VPS, a VM, a bare-metal box. The engine must be
able to start containers, so the host needs the Docker socket; platforms without one (Railway,
Render, Fly machines without Docker-in-Docker) cannot run the Computers and are not a target.
CI (`.github/workflows/publish-server-image.yml`) builds and publishes both images to GHCR on
every push to `main` and on release tags; a host pulls them with `IMAGE_REGISTRY` and `IMAGE_TAG`
set in `.env` and runs `docker compose … pull && up -d`.

## Layout

| Path | What |
|---|---|
| `engine.Dockerfile`, `computer.Dockerfile` | the two images; each has a `.dockerignore` allow-list next to it |
| `compose.yaml` | Postgres + engine (+ the Computer image under the `build` profile) |
| `build.sh` | builds both images, with mirrors, a company CA, multi-arch and push |
| `setup.sh`, `stop.sh`, `reset.sh` | one-command local start, stop, and wipe |
| `entrypoint.py` | the engine's server entrypoint (config, migrations, app) |
| `engine/` | `start.sh` and the engine config templates it renders; the agent bundles it offers come from [`engine/agents`](../engine/agents) |
| `postgres/schemas.sql` | creates the `engine` schema on first init |
| `systemd/` | a backup timer for a production host |

The Computer's helper commands, the pptx runtime and skill, deck export and dashboard assets, with
their tests, live in [`host/`](../host) at the repository root; `computer.Dockerfile` copies them in.
