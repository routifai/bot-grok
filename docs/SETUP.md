# Run Superchat locally with Docker

`./deployment/setup.sh` builds the whole stack from this checkout with Docker Compose. The services
and images are in the [README](../README.md#run-with-docker); this page is the walkthrough.

## Prerequisites

- Docker with the Compose plugin: Docker Desktop, colima
  (`colima start --cpu 4 --memory 8 --disk 60`) or Docker Engine on Linux.
- `openssl`.
- About 4 CPUs, 8 GB RAM and 40 GB of Docker disk (the first build needs room for its cache).

Node.js and pnpm are not needed; everything builds in Docker.

## What the stack runs

One Compose project, `superchat`, from `deployment/compose.yaml`. `setup.sh` runs, from the repo
root (`dc` standing for `docker compose --env-file .env -f deployment/compose.yaml`):

```sh
dc --profile build build computer
dc build engine
dc up -d --wait
```

| Service | Role | Host port |
|---|---|---|
| `postgres` | one database, `omnigent`, with an `engine` schema | none |
| `engine` | Superchat's engine; serves the web and the published apps; starts each person's Computer over the Docker socket | web `5173` (`SUPERCHAT_WEB_PORT`), engine `8012` (`SUPERCHAT_ENGINE_PORT`) |

There is no app server: the web is built into the engine image and talks to the engine directly. Open
http://127.0.0.1:5173.

`computer` only builds an image: it sits under the `build` profile, so `up` never creates a
container for it; the engine starts one per person. The engine image (`superchat/engine:local`,
`deployment/engine.Dockerfile`) is the engine package, the built web and the agent bundles. The
Computer (`superchat/computer:local`, `deployment/computer.Dockerfile`) is plain Ubuntu 24.04 with
the distro's Python, the claude and pi CLIs, Python's data stack, the pptx runtime, Chromium alone
(copied out of Playwright's image) and Superchat's helpers; one per person, no desktop or screen.
Its runner dials back to `ENGINE_PUBLIC_URL`, which is why the engine port is published.

## Setup

```sh
./deployment/setup.sh
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
Every Dockerfile that downloads packages (Omnigent's and the Computer's) also takes an optional build secret, `ca_bundle`: a PEM file with your company's CA, added
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
  engine:
    build:
      args:
        NODE_IMAGE: registry.mirror.example/node:22-slim
        PYTHON_IMAGE: registry.mirror.example/python:3.12-slim
        PYPI_INDEX_URL: https://pypi.mirror.example/simple
        NPM_CONFIG_REGISTRY: https://npm.mirror.example/
        TORCH_INDEX_URL: https://pypi.mirror.example/simple
      secrets: *ca
  computer:
    build:
      args:
        UBUNTU_IMAGE: registry.mirror.example/ubuntu:24.04
        NODE_IMAGE: registry.mirror.example/node:22-slim
        CHROMIUM_IMAGE: registry.mirror.example/playwright/python:v1.63.0-noble
        PYPI_INDEX_URL: https://pypi.mirror.example/simple
        NPM_CONFIG_REGISTRY: https://npm.mirror.example/
      secrets: *ca
```

```sh
docker compose --env-file .env \
  -f deployment/compose.yaml \
  -f /path/to/docker-compose.local.yaml up --build
```

Its relative paths resolve against `deployment/`, the first file's directory. Pull Docker Hub
images through the Docker daemon's registry mirror.

## Who you are

The web app has no sign-in of its own: it talks to the engine's REST API on its own origin (the
engine serves the web) and the engine decides who is asking.
Locally the engine runs with `OMNIGENT_LOCAL_SINGLE_USER=1`, so a request with no identity header is
the one local person; there is no sign-up.

### Hosted: a sign-in broker in front

For several people, put your organisation's SSO broker (an authenticating reverse proxy) in front of
the engine and:

1. Remove `OMNIGENT_LOCAL_SINGLE_USER` from the engine's environment, so a request with no identity
   is refused (the web then shows "You're not signed in").
2. Have the broker set the engine's identity header (`X-Forwarded-Email`, or the header named by
   `OMNIGENT_AUTH_HEADER`) to the signed-in person's email on every request, and add the shared
   `X-Omnigent-Proxy-Secret` equal to `OMNIGENT_AUTH_HEADER_SECRET` (`OMNIGENT_PROXY_SECRET` in
   `.env`). The engine honours the identity header only with that secret. The broker must strip any
   identity header a browser sends.
3. Optionally set `OMNIGENT_AUTH_TENANT_HEADER` and have the broker send the tenant (organisation)
   in that header.

## Data

Postgres lives in the `superchat_postgres-data` volume, the engine's state in
`superchat_artifact-data` (Omnigent's volume names), and Computer homes under `./data`.

## Stop, update, reset

```sh
./deployment/stop.sh     # stop, keep all data
./deployment/reset.sh    # stop and DELETE all data (asks first)
git pull && ./deployment/setup.sh   # update; keeps .env and secrets
```

## Troubleshooting

- **A Computer never starts.** The engine mounts the Docker socket. Leave `DOCKER_SOCKET_PATH`
  blank for Docker Desktop and colima (the path resolves inside the Docker VM); set it only for
  setups such as rootless Docker.
- **A Computer cannot reach the engine.** Check `ENGINE_PUBLIC_URL`. On native Linux use the Docker
  bridge address (for example `http://172.17.0.1:8012`) and set `SUPERCHAT_ENGINE_BIND` to it.
- **A service fails on boot.** The same `docker compose` command as above with `logs <service>`.
  A blank required secret fails closed; re-run `./deployment/setup.sh` to fill it.
- **Port in use.** Set `SUPERCHAT_WEB_PORT` (web) or `SUPERCHAT_ENGINE_PORT` (engine) in `.env`,
  then re-run setup.
