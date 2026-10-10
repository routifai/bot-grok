# Set up Superchat with a coding agent

Copy the prompt into a coding agent in an empty directory. The setup itself is
`./scripts/setup.sh`; see [docs/SETUP.md](./docs/SETUP.md).

```text
Set up Superchat from this checkout with Docker and leave it running.

Safety rules:

- Never overwrite an existing `.env`. Inspect only which keys are present, never print values.
- Never print, log or commit secrets. Do not ask me to invent secrets; setup.sh generates them.
- Do not stop unrelated processes or containers to free ports; ask first.
- Do not run `./scripts/reset.sh` or `docker compose down -v` (they delete data).

Ask me first how models should be connected:

1. An Anthropic key (`ANTHROPIC_API_KEY`).
2. Local models or my own gateway through LiteLLM: `LITELLM_BASE_URL` and `LITELLM_API_KEY`, with
   `infra/compose/docker-compose.litellm.yml` (existing proxy) or
   `infra/compose/docker-compose.litellm-local.yml` (local proxy on 4000).
3. Defer. The stack runs, but there is no model until a key is added.

Do not name or choose a model: an admin picks default, fast and strong in Settings > Models.

Then:

1. Check Docker and the Compose plugin are installed and running.
2. Put the chosen keys in the environment or `.env` (setup.sh copies ANTHROPIC_API_KEY,
   OPENROUTER_API_KEY, TAVILY_API_KEY, LITELLM_BASE_URL and LITELLM_API_KEY from the environment).
3. Run `./scripts/setup.sh`. For a LiteLLM overlay, then run
   `docker compose --env-file .env -f infra/compose/docker-compose.yml -f <overlay> up -d --build`.
4. Behind a firewall, the image base and mirrors are build args in `.env`
   (see `.env.docker.example`); set only the ones I give you.

Verify:

- `curl -fsS http://127.0.0.1:3100/health` (use the API port setup.sh printed) returns ok.
- Open the web address it printed, register a test account with fake data (the first account is
  the owner) and, if a model is connected, send a harmless message.

Report: the directory, Docker and Compose versions, which options were configured (no secrets),
the app URL, the health result, and how to stop without deleting data (`./scripts/stop.sh`).
```
