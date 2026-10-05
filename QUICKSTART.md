# Nova quickstart

> Chat runs on the Omnigent engine, which `./scripts/setup.sh` does not start. For a full local setup follow the [README quickstart](./README.md#quickstart-local-development); this page covers the Docker app stack only.

From zero to your own Nova in about 15 minutes. Everything runs in Docker on your machine; you
don't need Node.js or pnpm.

## 1. Before you start

- **Docker** with enough disk for the first build (at least 40 GB):
  - colima: `colima start --cpu 4 --memory 8 --disk 60`
  - Docker Desktop: Settings → Resources → give it 4 CPUs, 8 GB memory, 60 GB disk.
- **A model.** Either an OpenRouter or Anthropic key, or your own OpenAI-compatible server
  (LiteLLM, vLLM, Ollama, LM Studio).

## 2. Get the code

```bash
git clone <repo-url> nova
cd nova
```

## 3. Tell Nova which model to use

Create `.env` from the template and fill in the model section:

```bash
cp .env.docker.example .env
```

**OpenRouter or Anthropic:**

```bash
PI_DEFAULT_PROVIDER=openrouter        # or anthropic
OPENROUTER_API_KEY=sk-or-...          # or ANTHROPIC_API_KEY=sk-ant-...
```

**Your own LiteLLM (or any OpenAI-compatible server):**

```bash
PI_DEFAULT_PROVIDER=local
AIDEN_LOCAL_MODELS_URL=http://host.docker.internal:4000/v1   # server on this laptop
AIDEN_LOCAL_MODELS=gpt-4o,claude-sonnet                       # as the server names them; first = default
AIDEN_LOCAL_MODELS_API_KEY=sk-...                             # only if the server needs a key
AIDEN_LOCAL_VISION_MODELS=gpt-4o,claude-sonnet                # the ones that accept images
```

- Use `host.docker.internal`, not `localhost`: inside Docker, `localhost` is the container itself.
- List image-capable models in `AIDEN_LOCAL_VISION_MODELS` so Nova can see its computer's screen.

Everything else in `.env` (passwords, secrets) is generated for you in the next step.

## 4. Start it

```bash
./scripts/setup.sh
```

The first run builds everything (a few minutes). It ends with the address to open, usually
**http://127.0.0.1:5173**. If that port is taken, it picks the next free one and tells you.

When it's running, `docker ps` shows five containers: `aiden-postgres-1`, `aiden-api-1`,
`aiden-worker-1`, `aiden-web-1`, `aiden-supervisor-1`. An `aiden-bot-…` container appears the first
time Nova uses its computer.

## 5. First time in the app

1. **Sign up.** The first account on this install is the owner.
2. **Name your Nova** and pick its color.
3. **Say hi.** Try one of the suggestions, or give it a goal: "Help me prepare the Q3 client
   portfolio review." Its computer boots on first use (about 20–30 seconds).

## Everyday commands

| What | Command |
| --- | --- |
| Update to the latest version | `git pull && ./scripts/setup.sh` |
| Stop Nova | `./scripts/stop.sh` |
| Start it again | `./scripts/setup.sh` |
| Wipe everything and start fresh | `./scripts/reset.sh` (asks you to confirm) |
| See logs | `docker compose -f infra/compose/docker-compose.yml logs -f api` |

## If something looks wrong

- **Only Postgres is running.** You started the developer mode (`pnpm dev`), where only the
  database runs in Docker. Stop it and use `./scripts/setup.sh` instead.
- **The page shows random codes instead of text, or the old "team of agents" welcome page.** You
  have an older version: `git pull && ./scripts/setup.sh`, then reload the page.
- **It asks you to connect a model.** The model in `.env` isn't set or is misspelled. Check step 3,
  then re-run `./scripts/setup.sh`.
- **"Port already in use".** `./scripts/setup.sh` moves to a free port by itself; open the
  address it prints. Don't change the port by hand in `.env` without re-running the script.
- **The computer screen stays black or says "Can't connect".** Re-run `./scripts/setup.sh`. On
  colima, leave `DOCKER_SOCKET_PATH` blank in `.env`.
- **The build fails with "no space left on device".** Give Docker a bigger disk (step 1), then run
  `docker builder prune -af` and try again.

More detail: [docs/SETUP.md](./docs/SETUP.md).
