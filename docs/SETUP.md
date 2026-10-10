# Run Superchat locally with Docker

`./scripts/setup.sh` builds the whole stack from this checkout with Docker Compose. The services
and images are in the [README](../README.md#run-with-docker); this page is the walkthrough.

## Prerequisites

- Docker with the Compose plugin: Docker Desktop, colima
  (`colima start --cpu 4 --memory 8 --disk 60`) or Docker Engine on Linux.
- `openssl`.
- About 4 CPUs, 8 GB RAM and 40 GB of Docker disk (the first build needs room for its cache).

Node.js and pnpm are not needed; everything builds in Docker.

## What the stack runs

One Compose project, `superchat`, from `infra/compose/docker-compose.yml`:

| Service | Role | Host port |
|---|---|---|
| `postgres` | one database, `superchat_db`, with `app` and `engine` schemas | none |
| `engine` | Omnigent agent server | `8012` (`SUPERCHAT_ENGINE_PORT`) |
| `supervisor` | starts and stops each person's Computer | none |
| `api` | sign-in, accounts, authorization | `3100` (`SUPERCHAT_API_PORT`) |
| `worker` | background jobs for the API | none |
| `web` | the interface | `5173` (`SUPERCHAT_WEB_PORT`) |

`omnigent-host` and `computer` only build images and exit. The Computer
(`superchat/computer:local`) is Omnigent's host image plus Python's data stack, the pptx runtime,
headless Chromium and Superchat's helpers; one per person, no desktop or screen. Its runner dials
back to `ENGINE_PUBLIC_URL`, which is why the engine port is published.

## Setup

```sh
./scripts/setup.sh
```

It creates `.env` from `.env.docker.example` (or keeps yours and adds missing keys), fills blank
secrets with `openssl rand`, copies `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `TAVILY_API_KEY`,
`LITELLM_BASE_URL` and `LITELLM_API_KEY` from your environment when `.env` lacks them, then builds
and starts the stack and waits for it to be healthy.

## Models

No model is named in configuration. The engine lists models from its connection, and an admin picks
the default, fast and strong models in **Settings > Models**.

- **Anthropic**: set `ANTHROPIC_API_KEY` in `.env`.
- **Your own gateway**: set `LITELLM_BASE_URL` (root URL, no `/v1`) and `LITELLM_API_KEY`; the
  engine then routes every model call through that LiteLLM proxy. Inside Docker, `localhost` is the
  container; reach a proxy on your machine at `host.docker.internal`. The key stays in the engine
  and never enters a Computer.

## Restricted networks

`PYTHON_IMAGE` (the engine and Computer base, default `python:3.12-slim`), `PYPI_INDEX_URL` and
`NPM_CONFIG_REGISTRY` in `.env` point the builds at approved mirrors. Pull Docker Hub images
through the Docker daemon's registry mirror. See also
[self-host-restricted-network.md](./self-host-restricted-network.md).

## First sign-up

The first account you register becomes the deployment owner. There is no separate admin step.

## Data

Postgres lives in the `superchat_pgdata` volume, the engine's state in `superchat_enginedata`, and
Computer homes under `./data`.

## Stop, update, reset

```sh
./scripts/stop.sh     # stop, keep all data
./scripts/reset.sh    # stop and DELETE all data (asks first)
git pull && ./scripts/setup.sh   # update; keeps .env and secrets
```

## Troubleshooting

- **A Computer never starts.** The supervisor mounts the Docker socket. Leave `DOCKER_SOCKET_PATH`
  blank for Docker Desktop and colima (the path resolves inside the Docker VM); set it only for
  setups such as rootless Docker.
- **A Computer cannot reach the engine.** Check `ENGINE_PUBLIC_URL`. On native Linux use the Docker
  bridge address (for example `http://172.17.0.1:8012`) and set `SUPERCHAT_ENGINE_BIND` to it.
- **A service fails on boot.** `docker compose -f infra/compose/docker-compose.yml logs <service>`.
  A blank required secret fails closed; re-run `./scripts/setup.sh` to fill it.
- **Port in use.** Set `SUPERCHAT_WEB_PORT` or `SUPERCHAT_API_PORT`, and the web port in
  `BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL`, then re-run setup.
