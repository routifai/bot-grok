#!/usr/bin/env bash
# One-command Docker setup for Aiden (build-from-source). Idempotent: safe to re-run.
# See docs/SETUP.md for the full walkthrough and troubleshooting.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
ENV_EXAMPLE="$ROOT/.env.docker.example"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.yml"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- 1. Docker present and running -----------------------------------------------------------

command -v docker >/dev/null 2>&1 || fail "Docker not found. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or colima (brew install colima docker docker-compose), then re-run this script."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin is missing. Docker Desktop and 'brew install docker-compose' both provide it."
if ! docker info >/dev/null 2>&1; then
  fail "Docker isn't running. Start Docker Desktop, or run 'colima start --cpu 4 --memory 8', then re-run this script."
fi
log "Docker is running ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown))."

# --- 2. .env from the Docker template --------------------------------------------------------

if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$ENV_EXAMPLE" ]] || fail "Missing $ENV_EXAMPLE"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  log "Created .env from .env.docker.example."
else
  log ".env already exists — keeping it, only filling in blanks."
fi

# Merge in any keys .env.docker.example has that .env is missing (safe re-run after an upgrade).
while IFS= read -r line; do
  if [[ "$line" == \#* || -z "$line" ]]; then
    continue
  fi
  key="${line%%=*}"
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s\n' "$line" >>"$ENV_FILE"
  fi
done <"$ENV_EXAMPLE"

env_get() { grep "^${1}=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

env_set() {
  local key="$1" value="$2"
  awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v; done=1} {print} END{if(!done) print k"="v}' \
    "$ENV_FILE" >"$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

fill_if_blank() {
  local key="$1" generator="$2"
  if [[ -z "$(env_get "$key")" ]]; then
    env_set "$key" "$($generator)"
    log "Generated $key."
  fi
}

# --- 3. Random secrets ------------------------------------------------------------------------

command -v openssl >/dev/null 2>&1 || fail "openssl not found — needed to generate secrets."
fill_if_blank POSTGRES_PASSWORD "openssl rand -hex 16"
fill_if_blank BETTER_AUTH_SECRET "openssl rand -hex 32"
fill_if_blank ENCRYPTION_KEY "openssl rand -hex 32"
fill_if_blank SCREEN_PROXY_SECRET "openssl rand -hex 32"
fill_if_blank SANDBOX_SUPERVISOR_TOKEN "openssl rand -hex 32"

# --- 3b. Free ports, and URLs that match them ------------------------------------------------
# If 5173/3100 are taken by something else (another dev server), move to the next free port. The
# app's own URLs (sign-in callbacks, allowed origins) must use the same web port, so keep the
# loopback ones in sync; custom hostnames are left alone.

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
next_free_port() {
  local port="$1"
  while port_in_use "$port"; do port=$((port + 1)); done
  echo "$port"
}
stack_running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

web_port="$(env_get AIDEN_WEB_PORT)"; web_port="${web_port:-5173}"
if ! stack_running aiden-web-1 && port_in_use "$web_port"; then
  web_port="$(next_free_port "$web_port")"
  env_set AIDEN_WEB_PORT "$web_port"
  log "Port in use; the web app will use port $web_port."
fi
api_port="$(env_get AIDEN_API_PORT)"; api_port="${api_port:-3100}"
if ! stack_running aiden-api-1 && port_in_use "$api_port"; then
  api_port="$(next_free_port "$api_port")"
  env_set AIDEN_API_PORT "$api_port"
  log "Port in use; the API will use port $api_port."
fi
for key in BETTER_AUTH_URL WEB_ORIGIN API_URL; do
  current="$(env_get "$key")"
  if [[ -z "$current" || "$current" =~ ^http://(127\.0\.0\.1|localhost):[0-9]+/?$ ]]; then
    env_set "$key" "http://127.0.0.1:${web_port}"
  fi
done

# --- 4. Docker socket for the sandbox supervisor --------------------------------------------
# The supervisor mounts the Docker socket to start per-Aiden computers. Mount paths resolve inside
# the Docker VM, where both Docker Desktop and colima expose /var/run/docker.sock, so the compose
# default is right for them. DOCKER_SOCKET_PATH in .env is only an override for unusual setups
# (e.g. rootless Docker on Linux); never the Mac-side path such as ~/.colima/default/docker.sock.

socket_override="$(env_get DOCKER_SOCKET_PATH)"
if [[ "$socket_override" == "$HOME/.colima/"* ]]; then
  env_set DOCKER_SOCKET_PATH ""
  log "Cleared DOCKER_SOCKET_PATH: colima's Mac-side socket can't be mounted; the VM path is used."
fi

# --- 5. Model provider key (optional) --------------------------------------------------------

if [[ -z "$(env_get OPENROUTER_API_KEY)" && -z "$(env_get ANTHROPIC_API_KEY)" && -z "$(env_get AIDEN_LOCAL_MODELS)" ]]; then
  if [[ -n "${OPENROUTER_API_KEY:-}" ]]; then
    env_set OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
    log "Using OPENROUTER_API_KEY from the environment."
  elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    env_set ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
    log "Using ANTHROPIC_API_KEY from the environment."
  elif [[ -t 0 && -t 1 && "${CI:-}" != "true" ]]; then
    echo
    echo "Connect a model for every account on this deployment (optional)."
    echo "Skip this and connect a model per-account instead from the Aiden UI after sign-up"
    echo "(onboarding, or Settings -> Models) — nothing here is required for that path."
    read -r -s -p "OpenRouter API key (leave blank to skip): " key_input
    echo
    if [[ -n "$key_input" ]]; then
      env_set OPENROUTER_API_KEY "$key_input"
      log "Saved OPENROUTER_API_KEY to .env."
    else
      log "No deployment-wide model key set. Connect one per-account in the UI after sign-up."
    fi
  else
    log "No deployment-wide model key set (non-interactive run). Connect one per-account in the UI after sign-up, or set OPENROUTER_API_KEY / ANTHROPIC_API_KEY / AIDEN_LOCAL_MODELS (see docs/SETUP.md) and re-run."
  fi
else
  log "Model key already configured in .env."
fi

# --- 6. Build the computer image -------------------------------------------------------------

log "Building the computer image (aiden/computer:local) — first build takes a few minutes..."
# Root context (not infra/sandboxes/computer) so the image can vendor engine/omnigent — see
# infra/sandboxes/computer/Dockerfile's omnigent-builder stage.
docker build -t aiden/computer:local -f "$ROOT/infra/sandboxes/computer/Dockerfile" "$ROOT"

# --- 7. Build and start the stack ------------------------------------------------------------

log "Building api, worker, web, and the sandbox supervisor from source..."
"${compose[@]}" build
log "Starting Aiden..."
"${compose[@]}" up -d --wait --wait-timeout 300

# --- 8. Wait for health and report -------------------------------------------------------------

api_port="$(env_get AIDEN_API_PORT)"; api_port="${api_port:-3100}"
web_port="$(env_get AIDEN_WEB_PORT)"; web_port="${web_port:-5173}"
if curl -fsS "http://127.0.0.1:${api_port}/health" >/dev/null 2>&1; then
  log "API is healthy."
else
  warn "API did not report healthy yet. Check logs: docker compose -f infra/compose/docker-compose.yml logs api"
fi

echo
log "Aiden is running: http://127.0.0.1:${web_port}"
echo "    The first account you register becomes the deployment owner."
echo "    Stop it:  ./scripts/stop.sh"
echo "    Reset it: ./scripts/reset.sh (deletes all data)"
