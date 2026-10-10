# Run Superchat locally with Docker

`./scripts/setup.sh` builds the whole stack from this checkout with Docker Compose. Architecture
and the overlay table are in the [README](../README.md#run-with-docker); this page is the walkthrough.

## Prerequisites

- Docker with the Compose plugin: Docker Desktop, colima
  (`colima start --cpu 4 --memory 8 --disk 60`) or Docker Engine on Linux.
- `openssl` and `curl`.
- About 4 CPUs, 8 GB RAM and 40 GB of Docker disk (the first build needs room for its cache).

Node.js and pnpm are not needed; everything builds in Docker.

## What the stack runs

One Compose project, `superchat`, from `infra/compose/docker-compose.yml`:

| Service | Role | Host port |
|---|---|---|
| `postgres` | one database, `superchat_db` (app and engine schemas); `db-init` creates the schemas | none |
| `engine` | Omnigent agent server | `8012` (`SUPERCHAT_ENGINE_PORT`) |
| `supervisor` | starts and stops each person's Computer | none |
| `api` | sign-in, accounts, authorization | `3100` (`SUPERCHAT_API_PORT`) |
| `worker` | background jobs for the API | none |
| `web` | the interface | `5173` (`SUPERCHAT_WEB_PORT`) |

The Computer (`superchat/computer:local`) is a headless Ubuntu 24.04 container, one per person. It
has no desktop or screen. The engine's runner there dials back to `ENGINE_PUBLIC_URL`, which is why
the engine port is published.

## Setup

```sh
./scripts/setup.sh
```

The script:

1. Checks Docker is installed and running.
2. Creates `.env` from `.env.docker.example`, or keeps yours and only adds missing keys.
3. Fills blank secrets with `openssl rand`: `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`,
   `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET`, `SANDBOX_SUPERVISOR_TOKEN`, `OMNIGENT_PROXY_SECRET`
   and `OMNIGENT_VAULT_KEY`.
4. Moves the web and API ports if `5173` or `3100` are taken, and keeps `BETTER_AUTH_URL`,
   `WEB_ORIGIN` and `API_URL` in step.
5. Copies `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `LITELLM_BASE_URL` and
   `LITELLM_API_KEY` from your environment when `.env` lacks them. If neither an Anthropic key nor
   `LITELLM_BASE_URL` is set, it asks for an Anthropic key (Enter skips; the engine then has no
   model until you add one to `.env`).
6. Builds the Computer image and the other images, starts the stack and waits for it to be healthy.

## Models

No model is named in configuration. The engine lists models from its connection, and an admin picks
the default, fast and strong models in **Settings > Models**.

- **Anthropic**: set `ANTHROPIC_API_KEY` in `.env`.
- **Local models or your own gateway**: route all model calls through LiteLLM with an overlay.
  Set `LITELLM_BASE_URL` (root URL, no `/v1`) and `LITELLM_API_KEY` in `.env`, then add one of:

  | Overlay | What |
  |---|---|
  | `docker-compose.litellm.yml` | an existing LiteLLM proxy |
  | `docker-compose.litellm-local.yml` | a local proxy on `4000` (`LITELLM_PORT`), configured in `infra/compose/litellm/config.yaml` |

  ```sh
  docker compose --env-file .env -f infra/compose/docker-compose.yml \
    -f infra/compose/docker-compose.litellm.yml up -d --build
  ```

  Inside Docker, `localhost` is the container; reach a proxy on your machine at
  `host.docker.internal`. The key stays in the engine and never enters a Computer.

## Restricted networks

Base images and package mirrors are build args set in `.env`: `BASE_IMAGE`, `NODE_IMAGE`,
`APT_MIRROR`, `NPM_CONFIG_REGISTRY`, `PYPI_INDEX_URL` and `PLAYWRIGHT_DOWNLOAD_HOST`. They are
commented out by default (public sources); see `.env.docker.example` for what each one replaces.
See also [self-host-restricted-network.md](./self-host-restricted-network.md).

## First sign-up

The first account you register becomes the deployment owner. There is no separate admin step.

## Data and backups

Postgres lives in the `superchat_pgdata` volume, the engine's state in `superchat_enginedata`, and
Computer homes under `./data`. Back up with `./scripts/backup.sh` (see
[self-host.md](./self-host.md#backup)).

## Stop, update, reset

```sh
./scripts/stop.sh     # stop, keep all data
./scripts/reset.sh    # stop and DELETE all data (asks first)
git pull && ./scripts/setup.sh   # update; keeps .env and secrets
```

## Troubleshooting

- **A Computer never starts.** The supervisor mounts the Docker socket. Leave `DOCKER_SOCKET_PATH`
  blank for Docker Desktop and colima (the path resolves inside the Docker VM); set it only for
  setups such as rootless Docker. Never use colima's Mac-side socket path.
- **A Computer cannot reach the engine.** Check `ENGINE_PUBLIC_URL`. On native Linux use the Docker
  bridge address (for example `http://172.17.0.1:8012`) and set `SUPERCHAT_ENGINE_BIND` to it.
- **A service fails on boot.** `docker compose -f infra/compose/docker-compose.yml logs <service>`.
  A blank required secret fails closed; re-run `./scripts/setup.sh` to fill it.
- **Port in use.** Setup picks the next free port. To choose, set `SUPERCHAT_WEB_PORT` or
  `SUPERCHAT_API_PORT` and re-run it, so the app URLs follow.
