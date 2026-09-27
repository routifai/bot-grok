#!/usr/bin/env bash
# Stop the Docker stack and delete all its data: the Postgres volume, bot computer state under
# ./data, and stopped containers. Asks for confirmation first. Pass -y / --yes to skip the prompt.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/compose/docker-compose.yml"
compose=(docker compose -f "$COMPOSE_FILE")
if [[ -f "$ROOT/.env" ]]; then
  compose=(docker compose --env-file "$ROOT/.env" -f "$COMPOSE_FILE")
fi

assume_yes=0
for arg in "$@"; do
  if [[ "$arg" == "-y" || "$arg" == "--yes" ]]; then
    assume_yes=1
  fi
done

if [[ "$assume_yes" -ne 1 ]]; then
  echo "This deletes the Postgres database and all bot computer data for this stack."
  echo "That includes every account, conversation, and file created in this local Aiden."
  read -r -p "Type 'delete' to continue: " confirm
  if [[ "$confirm" != "delete" ]]; then
    echo "Cancelled. Nothing was deleted."
    exit 1
  fi
fi

"${compose[@]}" down -v
if [[ -d "$ROOT/data" ]]; then
  rm -rf "$ROOT/data"
fi
echo "Aiden's containers, volumes, and ./data are gone. Run ./scripts/setup.sh to start fresh."
