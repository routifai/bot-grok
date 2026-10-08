# Run Nova locally with Docker

This builds the app stack (Postgres, API, worker, web, sandbox supervisor) from this checkout with
Docker Compose. **Chat needs the Omnigent engine, which this stack does not start**: run it as
described in the [README quickstart](../README.md#quickstart-local-development) and
[RUNNERS.md](super-chat/RUNNERS.md), then set `OMNIGENT_URL` and `OMNIGENT_PROXY_SECRET` in `.env`.
The `PI_DEFAULT_*` model settings below apply to the app's own model features, not to the Muse's
model (see the README's Configuration table).

## Prerequisites

- **macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop/), or
  [colima](https://github.com/abiosoft/colima) (`brew install colima docker docker-compose`) started with
  enough resources for a Postgres, four app processes, and at least one bot computer:

  ```bash
  colima start --cpu 4 --memory 8 --disk 60
  ```

- **Linux**: Docker Engine + the Compose plugin (`docker compose version` should work).
- `openssl` and `curl` (already on macOS and most Linux distributions).
- About 4 CPUs / 8 GB RAM free, and a Docker disk of at least 40 GB (the first build needs room
  for its cache; Docker Desktop: Settings → Resources → Disk usage limit).

You do **not** need Node.js or pnpm — everything builds inside Docker.

## Quick start

```bash
git clone <repository-url> nova && cd nova
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
6. Builds the computer image (`nova/computer:local`) and the api/worker/web/supervisor images
   from this checkout, then starts the stack and waits for it to become healthy.

When it finishes, open **http://127.0.0.1:5173**.

## First sign-up

The **first account you register becomes the deployment owner**. There's no separate admin
setup step — just sign up like any other user.

## Choosing the model

Set the model once in `.env`. Nova then uses it for everyone, and nobody is asked to connect a
model in the app. After editing `.env`, re-run `./scripts/setup.sh`.

**OpenRouter or Anthropic**

```bash
PI_DEFAULT_PROVIDER=openrouter      # or anthropic
OPENROUTER_API_KEY=sk-or-...        # or ANTHROPIC_API_KEY=sk-ant-...
PI_DEFAULT_MODEL=                   # optional; blank uses Nova's default for that provider
```

**Your own OpenAI-compatible server (LiteLLM, vLLM, Ollama, LM Studio)**

```bash
PI_DEFAULT_PROVIDER=local
NOVA_LOCAL_MODELS_URL=http://host.docker.internal:4000/v1   # LiteLLM on this machine
NOVA_LOCAL_MODELS=gpt-4o,claude-sonnet                       # as the server names them; first = default
NOVA_LOCAL_MODELS_API_KEY=sk-litellm-...                     # only if the server needs a key
NOVA_LOCAL_VISION_MODELS=gpt-4o,claude-sonnet                # the ones that accept images
```

- Inside Docker, `localhost` is the container itself, so a server on your laptop is
  `host.docker.internal`. A server elsewhere on your network: use its LAN address or hostname.
- List the image-capable models in `NOVA_LOCAL_VISION_MODELS` so Nova can see its computer's
  screen.

People can still connect their own model under **Settings → Models** if you leave all of this
blank.

## What gets created

| Thing | Where |
| --- | --- |
| `.env` | Repo root — your secrets and settings. Never commit this. |
| Postgres data | Docker volume `nova_pgdata` (internal network only, no host port) |
| Bot computer / app data | `./data` in this checkout |
| Images | `nova/computer:local` (bot computers), `nova/app:local` (api/worker/web share one build), `nova-supervisor` (sandbox supervisor) |

Everything runs under the Compose project name `nova`; containers are named `nova-<service>-1`.

## Where data lives / backups

Bot computer homes and other application state live under `./data`; Postgres lives in the
`nova_pgdata` Docker volume. Back both up with:

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
The sandbox supervisor mounts the Docker socket to start per-Nova computers. The mount path is
resolved inside the Docker VM, where both Docker Desktop and colima use `/var/run/docker.sock`, so
leave `DOCKER_SOCKET_PATH` blank. Set it only for unusual setups such as rootless Docker on Linux
(for example `/run/user/1000/docker.sock`). Never use colima's Mac-side
`~/.colima/default/docker.sock` there: Docker can't mount a path from your Mac.

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
`./scripts/setup.sh` moves to the next free port on its own and prints the address to open. It
also points the app's own URLs (`BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL`) at that port. To choose
ports yourself, set `NOVA_WEB_PORT` / `NOVA_API_PORT` in `.env` and re-run the script; don't
change only the port, or sign-in and the page's product settings won't match.

**Still stuck?** See the full [self-hosting guide](./self-host.md) for provider setup, SMTP,
messaging integrations, and the single-VM production deployment path.

## Uninstall

```bash
./scripts/reset.sh    # stops containers and deletes the database + ./data
docker image rm nova/computer:local   # optional: also drop the built computer image
cd .. && rm -rf nova                   # remove the checkout itself
```
