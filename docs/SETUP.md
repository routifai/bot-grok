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

One Compose project, `superchat`: Omnigent's own `engine/omnigent/deploy/docker/docker-compose.yaml`
(Postgres and the Omnigent server), unchanged, with `infra/compose/docker-compose.superchat.yaml`
on top. `setup.sh` runs, from the repo root (`dc` standing for
`docker compose --env-file .env -f engine/omnigent/deploy/docker/docker-compose.yaml -f infra/compose/docker-compose.superchat.yaml`):

```sh
dc --profile build build omnigent-server ubuntu-python omnigent-host computer
dc build omnigent app
dc up -d --wait
```

Compose resolves relative paths in every file against the first file's directory, so run it from
the repo root with the files in this order.

| Service | Role | Host port |
|---|---|---|
| `postgres` | one database, `omnigent`, with `app` and `engine` schemas | none |
| `omnigent` | the Omnigent agent server (Superchat's engine); starts each person's Computer over the Docker socket | `8012` (`SUPERCHAT_ENGINE_PORT`) |
| `app` | the interface, its API and background worker, in one container (`infra/app/start.sh`) | `5173` (`SUPERCHAT_WEB_PORT`) |

`omnigent-server`, `ubuntu-python`, `omnigent-host` and `computer` only build images: they sit
under the `build` profile, so `up` never creates a container for them. `omnigent-server`
and `omnigent-host` are Omnigent's own images (its Dockerfile's server and `host` targets); the
engine (`superchat/engine:local`, `infra/omnigent/Dockerfile`) is the server image plus
`infra/omnigent` at `/opt/bundle`. The Computer (`superchat/computer:local`) is the host image,
built on plain Ubuntu 24.04 (`ubuntu-python`, the distro's Python) with only the claude and pi
CLIs, plus Python's data stack, the pptx runtime, Chromium alone (copied out of Playwright's image)
and Superchat's helpers; one per
person, no desktop or screen. Its runner dials back to `ENGINE_PUBLIC_URL`, which is why the engine
port is published.

## Setup

```sh
./scripts/setup.sh
```

It creates `.env` from `.env.docker.example` (or keeps yours and adds missing keys), fills blank
secrets with `openssl rand`, copies `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
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

`PYPI_INDEX_URL` and `NPM_CONFIG_REGISTRY` in `.env` point the builds at approved mirrors;
`UBUNTU_IMAGE`, `CHROMIUM_IMAGE`, `NODE_IMAGE` and `PYTHON_IMAGE` point the base images at a
registry mirror, and `TORCH_INDEX_URL` the engine's CPU-only torch at a mirror of PyTorch's CPU
index.
Every Dockerfile that downloads packages (Omnigent's, the Computer's and the app's) also takes an optional build secret, `ca_bundle`: a PEM file with your company's CA, added
to each image's trust store for apt, pip, uv, npm and pnpm. Without it the builds are unchanged.

To build behind a company proxy, keep the machine's settings in a third Compose file of your own,
outside the repo or untracked (for example `docker-compose.local.yaml`), and add it last:

```yaml
# docker-compose.local.yaml (placeholder names: use your own mirror and CA file)
x-ca: &ca [ca_bundle]

secrets:
  ca_bundle:
    file: ${HOME}/certs/company-ca-bundle.pem

services:
  # Omnigent's images. A machine with its own variant of Omnigent's Dockerfile points
  # `dockerfile` here at it; the engine and Computer are built FROM whatever these produce.
  omnigent-server:
    build:
      args:
        PYPI_INDEX_URL: https://pypi.mirror.example/simple
        NPM_CONFIG_REGISTRY: https://npm.mirror.example/
      secrets: *ca
  ubuntu-python:
    build:
      args:
        UBUNTU_IMAGE: registry.mirror.example/ubuntu:24.04
      secrets: *ca
  omnigent-host:
    build:
      args:
        PYPI_INDEX_URL: https://pypi.mirror.example/simple
        NPM_CONFIG_REGISTRY: https://npm.mirror.example/
      secrets: *ca
  # Superchat's layers.
  computer:
    build:
      args:
        CHROMIUM_IMAGE: registry.mirror.example/playwright/python:v1.63.0-noble
      secrets: *ca
  api: { build: { secrets: *ca } }
  worker: { build: { secrets: *ca } }
  web: { build: { secrets: *ca } }
```

```sh
docker compose --env-file .env \
  -f engine/omnigent/deploy/docker/docker-compose.yaml \
  -f infra/compose/docker-compose.superchat.yaml \
  -f /path/to/docker-compose.local.yaml up --build
```

Its relative paths, like the other two files', resolve against `engine/omnigent/deploy/docker`. An
existing local file written for Omnigent alone overrides `omnigent`; here the Omnigent image is
built by `omnigent-server` (and `omnigent-host`), so move those `build:` settings there: `omnigent`
is Superchat's thin engine layer. Pull Docker Hub images through the Docker daemon's registry
mirror.

## First sign-up

The first account you register becomes the deployment owner. There is no separate admin step.

## Data

Postgres lives in the `superchat_postgres-data` volume, the engine's state in
`superchat_artifact-data` (Omnigent's volume names), and Computer homes under `./data`.

## Stop, update, reset

```sh
./scripts/stop.sh     # stop, keep all data
./scripts/reset.sh    # stop and DELETE all data (asks first)
git pull && ./scripts/setup.sh   # update; keeps .env and secrets
```

## Troubleshooting

- **A Computer never starts.** The engine mounts the Docker socket. Leave `DOCKER_SOCKET_PATH`
  blank for Docker Desktop and colima (the path resolves inside the Docker VM); set it only for
  setups such as rootless Docker.
- **A Computer cannot reach the engine.** Check `ENGINE_PUBLIC_URL`. On native Linux use the Docker
  bridge address (for example `http://172.17.0.1:8012`) and set `SUPERCHAT_ENGINE_BIND` to it.
- **A service fails on boot.** The same `docker compose` command as above with `logs <service>`.
  A blank required secret fails closed; re-run `./scripts/setup.sh` to fill it.
- **Port in use.** Set `SUPERCHAT_WEB_PORT` or `SUPERCHAT_API_PORT`, and the web port in
  `BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL`, then re-run setup.
