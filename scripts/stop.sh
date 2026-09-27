#!/usr/bin/env bash
# Stop the Docker stack without deleting any data (containers and volumes stay intact).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.yml"
compose=(docker compose -f "$COMPOSE_FILE")
if [[ -f "$ROOT/.env" ]]; then
  compose=(docker compose --env-file "$ROOT/.env" -f "$COMPOSE_FILE")
fi

"${compose[@]}" stop
echo "Aiden stopped. Data is untouched — run ./scripts/setup.sh to start it again."
