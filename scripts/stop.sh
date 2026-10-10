#!/usr/bin/env bash
# Stop the Docker stack without deleting any data (containers and volumes stay intact).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
files=(-f "$ROOT/engine/omnigent/deploy/docker/docker-compose.yaml" -f "$ROOT/infra/compose/docker-compose.superchat.yaml")
compose=(docker compose "${files[@]}")
if [[ -f "$ROOT/.env" ]]; then
  compose=(docker compose --env-file "$ROOT/.env" "${files[@]}")
fi

"${compose[@]}" stop
echo "Superchat stopped. Data is untouched — run ./scripts/setup.sh to start it again."
