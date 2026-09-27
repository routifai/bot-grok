# Run Aiden locally with Docker

This is the fastest way to run this fork (Aiden, the Muse edition) on your own laptop. It builds
every service from this checkout, so you get this fork's changes — not the upstream project's
published images.

## Prerequisites

- **macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop/), or
  [colima](https://github.com/abiosoft/colima) (`brew install colima docker docker-compose`) started with
  enough resources for a Postgres, four app processes, and at least one bot computer:

  ```bash
  colima start --cpu 4 --memory 8
  ```

- **Linux**: Docker Engine + the Compose plugin (`docker compose version` should work).
- `openssl` and `curl` (already on macOS and most Linux distributions).
- About 4 CPUs / 8 GB RAM free, and a few GB of disk for images and Postgres data.

You do **not** need Node.js or pnpm — everything builds inside Docker.

## Quick start

```bash
git clone <this-repository-url> aiden && cd aiden
./scripts/setup.sh
```

That's it. The script:

1. Checks Docker is installed and running.
2. Creates `.env` from `.env.docker.example` (skipped if `.env` already exists).
3. Fills every required secret with `openssl rand` (Postgres password, auth secret, encryption
   key, screen-proxy secret, sandbox-supervisor token).
4. Detects your Docker socket path (Docker Desktop vs. colima) for the sandbox supervisor.
5. Asks once for an optional OpenRouter API key to connect a model for every account — press
   Enter to skip and connect one per-account from the UI instead (see below).
6. Builds the computer image (`aiden/computer:local`) and the api/worker/web/supervisor images
   from this checkout, then starts the stack and waits for it to become healthy.

When it finishes, open **http://127.0.0.1:5173**.

## First sign-up

The **first account you register becomes the deployment owner**. There's no separate admin
setup step — just sign up like any other user.

## Adding a model

If you skipped the model key during setup, connect one from the UI: during onboarding, or later
under **Settings → Models**. Add a provider API key (OpenRouter, Anthropic, and others), or use
ChatGPT Plus/Pro, GitHub Copilot, or SuperGrok / X Premium sign-in instead of a raw key. Bots
cannot answer messages until a model is connected one way or the other.

To instead configure a model for every account on this deployment, set `OPENROUTER_API_KEY` (or
`ANTHROPIC_API_KEY`) in `.env` and re-run `./scripts/setup.sh` (or
`docker compose -f infra/compose/docker-compose.yml up -d api worker` to restart just those two).

## What gets created

| Thing | Where |
| --- | --- |
| `.env` | Repo root — your secrets and settings. Never commit this. |
| Postgres data | Docker volume `aiden_pgdata` (internal network only, no host port) |
| Bot computer / app data | `./data` in this checkout |
| Images | `aiden/computer:local` (bot computers), `aiden/app:local` (api/worker/web share one build), `aiden-supervisor` (sandbox supervisor) |

Everything runs under the Compose project name `aiden`; containers are named `aiden-<service>-1`.

## Where data lives / backups

Bot computer homes and other application state live under `./data`; Postgres lives in the
`aiden_pgdata` Docker volume. Back both up with:

```bash
./scripts/backup.sh
```

See [self-hosting: Backup](./self-host.md#backup) for what that script does and how to restore.

## Stopping and updating

```bash
./scripts/stop.sh    # stop containers, keep all data
./scripts/reset.sh    # stop containers and DELETE all data (asks for confirmation first)
```

To update to the latest code:

```bash
git pull
./scripts/setup.sh
```

Re-running `setup.sh` is safe: it keeps your existing `.env` and secrets, and only rebuilds and
restarts the stack.

## Troubleshooting

**A bot's computer pane is black, or never leaves "starting."**
The sandbox supervisor needs your host's Docker socket to start per-bot computer containers.
`scripts/setup.sh` auto-detects this, but if it guessed wrong, set `DOCKER_SOCKET_PATH` in `.env`:

| Setup | Socket path |
| --- | --- |
| Docker Desktop (macOS/Windows) | `/var/run/docker.sock` (default, leave blank) |
| Linux Docker Engine | `/var/run/docker.sock` (default, leave blank) |
| colima | `$HOME/.colima/default/docker.sock` |
| colima with a custom profile | `$HOME/.colima/<profile>/docker.sock` |

After changing it, restart: `docker compose -f infra/compose/docker-compose.yml up -d --force-recreate supervisor`.

If the computer still can't be reached after that (common on some Docker Desktop networking
setups), set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env` and restart the supervisor the same
way — this publishes the bot's control channel on a token-guarded loopback port instead of
routing through the container network.

**API fails to start / crashes on boot.**
Check the logs: `docker compose -f infra/compose/docker-compose.yml logs api`. A missing or
empty `POSTGRES_PASSWORD`, `SANDBOX_SUPERVISOR_TOKEN`, or `SCREEN_PROXY_SECRET` fails the stack
closed by design — re-run `./scripts/setup.sh` to fill any that are still blank.

**"Too many database connections" / pool errors under load.**
Each of `api` and `worker` keeps its own bounded Postgres pool (`api` defaults to 4 connections,
`worker` to 8). If you also run other tools against the same Postgres, set `DB_POOL_MAX` in
`.env` to size both processes explicitly (see `.env.example` for details), then restart.

**Port already in use (3100 or 5173).**
Something else is bound to that port — often the maintainer's own `pnpm dev` stack, which uses
the same defaults. Set `AIDEN_API_PORT` and/or `AIDEN_WEB_PORT` in `.env` to free ports, then
re-run `./scripts/setup.sh`.

**Still stuck?** See the full [self-hosting guide](./self-host.md) for provider setup, SMTP,
messaging integrations, and the single-VM production deployment path.

## Uninstall

```bash
./scripts/reset.sh    # stops containers and deletes the database + ./data
docker image rm aiden/computer:local   # optional: also drop the built computer image
cd .. && rm -rf aiden                   # remove the checkout itself
```
