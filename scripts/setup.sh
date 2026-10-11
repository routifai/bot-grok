#!/usr/bin/env bash
# One-command Docker setup: writes .env from .env.docker.example, fills its secrets, then builds
# and starts Omnigent's compose file with infra/compose/docker-compose.superchat.yaml on top. Safe to re-run: existing values are kept.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
compose=(docker compose --env-file "$ENV_FILE" -f "$ROOT/engine/omnigent/deploy/docker/docker-compose.yaml" -f "$ROOT/infra/compose/docker-compose.superchat.yaml")

docker info >/dev/null 2>&1 || { echo "error: Docker isn't running." >&2; exit 1; }

# .env from the template; keys the template gained since are appended.
touch "$ENV_FILE"
while IFS= read -r line; do
  [[ "$line" == \#* || -z "$line" ]] && continue
  grep -q "^${line%%=*}=" "$ENV_FILE" || printf '%s\n' "$line" >>"$ENV_FILE"
done <"$ROOT/.env.docker.example"

env_get() { grep "^${1}=" "$ENV_FILE" | head -n1 | cut -d= -f2- || true; }
env_set() {
  awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}
fill() { [[ -n "$(env_get "$1")" ]] || env_set "$1" "$2"; }

# Secrets, and any model key this shell already has.
fill POSTGRES_PASSWORD "$(openssl rand -hex 16)"
fill OMNIGENT_PROXY_SECRET "$(openssl rand -hex 32)"
fill OMNIGENT_VAULT_KEY "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
for key in ANTHROPIC_API_KEY OPENROUTER_API_KEY LITELLM_BASE_URL LITELLM_API_KEY; do
  [[ -z "${!key:-}" ]] || fill "$key" "${!key}"
done
[[ -n "$(env_get ANTHROPIC_API_KEY)$(env_get LITELLM_BASE_URL)" ]] ||
  echo "warning: set ANTHROPIC_API_KEY (or LITELLM_BASE_URL + LITELLM_API_KEY) in .env for the engine." >&2

# Base images and the Computer image first (the "build" profile keeps them out of `up`), then the
# engine (which also builds and serves the web) on top of its base.
"${compose[@]}" --profile build build omnigent-server ubuntu-python omnigent-host computer
"${compose[@]}" build omnigent
"${compose[@]}" up -d --wait --wait-timeout 300
echo "Superchat is running: http://127.0.0.1:$(env_get SUPERCHAT_WEB_PORT | grep . || echo 5173)"
