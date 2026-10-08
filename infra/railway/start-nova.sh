#!/usr/bin/env bash
# Runs the Nova API, the background worker and the web server in ONE container.
# Why one: the API and worker share DATA_DIR (a Railway volume attaches to a single service),
# and the web server proxies /api, /rpc and the live screen to the API on 127.0.0.1:3100.
# Railway routes public traffic to $PORT (the web server). If any process exits, the container
# exits so Railway restarts all three.
set -uo pipefail

pnpm --filter @aiden/db exec prisma migrate deploy || exit 1

API_PORT=3100 pnpm --filter @aiden/api start &
api=$!
pnpm --filter @aiden/worker start &
worker=$!
API_PROXY_TARGET=http://127.0.0.1:3100 pnpm --filter @aiden/web preview --host 0.0.0.0 --port "${PORT:-5173}" &
web=$!

trap 'kill "$api" "$worker" "$web" 2>/dev/null' TERM INT
wait -n "$api" "$worker" "$web"
code=$?
kill "$api" "$worker" "$web" 2>/dev/null
wait
exit "$code"
