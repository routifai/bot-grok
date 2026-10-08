#!/usr/bin/env bash
# Renders the engine config from the environment, then starts the Omnigent server.
set -euo pipefail

: "${ENGINE_PUBLIC_URL:?Set ENGINE_PUBLIC_URL to the public https URL of this service}"
: "${DATABASE_URL:?Set DATABASE_URL to the engine Postgres reference}"
: "${OMNIGENT_AUTH_HEADER_SECRET:?Set OMNIGENT_AUTH_HEADER_SECRET}"
: "${OMNIGENT_COMPUTER_SUPERVISOR_URL:?Set OMNIGENT_COMPUTER_SUPERVISOR_URL}"
: "${OMNIGENT_COMPUTER_SUPERVISOR_TOKEN:?Set OMNIGENT_COMPUTER_SUPERVISOR_TOKEN}"
: "${OMNIGENT_VAULT_KEY:?Set OMNIGENT_VAULT_KEY}"
: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY}"

# Default the strong helper model to the Muse model unless set explicitly.
export OMNIGENT_HELPER_MODEL_STRONG="${OMNIGENT_HELPER_MODEL_STRONG:-$NOVA_CLAUDE_MODEL}"

mkdir -p "$OMNIGENT_DATA_DIR" "$OMNIGENT_CONFIG_HOME" "$ARTIFACT_DIR"
url="${ENGINE_PUBLIC_URL%/}"
# '|' as the sed delimiter: URLs contain '/'. The URL is operator-supplied, not user input.
sed "s|__ENGINE_PUBLIC_URL__|${url}|g" /opt/nova/config.yaml.tmpl > "$OMNIGENT_DATA_DIR/config.yaml"
export OMNIGENT_CONFIG="$OMNIGENT_DATA_DIR/config.yaml"

exec python /app/entrypoint.py
