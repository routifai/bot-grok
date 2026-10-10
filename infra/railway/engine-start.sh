#!/usr/bin/env bash
# Renders the engine config from the environment, then starts the Omnigent server.
#
# The template is ENGINE_CONFIG_TEMPLATE (default: the Anthropic-key one). Its __NAME__
# placeholders are literal values filled in here (URLs, model ids: the engine does not expand
# them); its ${NAME} references are secrets the engine expands itself. Every one must be set.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the engine Postgres reference}"
: "${OMNIGENT_AUTH_HEADER_SECRET:?Set OMNIGENT_AUTH_HEADER_SECRET}"
: "${OMNIGENT_COMPUTER_SUPERVISOR_URL:?Set OMNIGENT_COMPUTER_SUPERVISOR_URL}"
: "${OMNIGENT_COMPUTER_SUPERVISOR_TOKEN:?Set OMNIGENT_COMPUTER_SUPERVISOR_TOKEN}"
: "${OMNIGENT_VAULT_KEY:?Set OMNIGENT_VAULT_KEY}"

# Default the strong helper model to the Muse model unless set explicitly.
export OMNIGENT_HELPER_MODEL_STRONG="${OMNIGENT_HELPER_MODEL_STRONG:-$SUPERCHAT_CLAUDE_MODEL}"

mkdir -p "$OMNIGENT_DATA_DIR" "$OMNIGENT_CONFIG_HOME" "$ARTIFACT_DIR"
template="${ENGINE_CONFIG_TEMPLATE:-/opt/superchat/config.yaml.tmpl}"
python - "$template" "$OMNIGENT_DATA_DIR/config.yaml" <<'PY'
import os
import re
import sys

source, target = sys.argv[1], sys.argv[2]
lines = open(source, encoding="utf-8").read().splitlines(keepends=True)
live = [line for line in lines if not line.lstrip().startswith("#")]
placeholders = {m for line in live for m in re.findall(r"__([A-Z][A-Z0-9_]*)__", line)}
references = {m for line in live for m in re.findall(r"\$\{([A-Z][A-Z0-9_]*)\}", line)}
missing = sorted(name for name in placeholders | references if not os.environ.get(name))
if missing:
    sys.exit(f"engine config {source}: set {', '.join(missing)}")


def value(match: re.Match[str]) -> str:
    # URLs are written without a trailing slash; the config appends paths to them.
    return os.environ[match.group(1)].strip().rstrip("/")


rendered = "".join(
    line if line.lstrip().startswith("#") else re.sub(r"__([A-Z][A-Z0-9_]*)__", value, line)
    for line in lines
)
with open(target, "w", encoding="utf-8") as handle:
    handle.write(rendered)
PY
export OMNIGENT_CONFIG="$OMNIGENT_DATA_DIR/config.yaml"

exec python /app/entrypoint.py
