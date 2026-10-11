#!/usr/bin/env bash
# Runs the Superchat API, the background worker and the web server in ONE container.
# Why one: the API and worker share DATA_DIR (one volume), and the web server proxies /api and
# /rpc to the API on 127.0.0.1:3100. Public traffic goes to $PORT (the web server, 5173 unless the
# platform sets it). If any process exits, the container exits so it is restarted as a whole.
set -uo pipefail

pnpm --filter @superchat/db exec prisma migrate deploy || exit 1

API_PORT=3100 pnpm --filter @superchat/api start &
api=$!
pnpm --filter @superchat/worker start &
worker=$!
# Open the public port only once the API listens, so the first requests after a deploy are not
# proxied into a connection refused. Give up after 90 s and let the web server start anyway.
for _ in $(seq 1 90); do
  node -e "fetch('http://127.0.0.1:3100/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && break
  kill -0 "$api" 2>/dev/null || break
  sleep 1
done
API_PROXY_TARGET=http://127.0.0.1:3100 pnpm --filter @superchat/web preview --host 0.0.0.0 --port "${PORT:-5173}" &
web=$!

trap 'kill "$api" "$worker" "$web" 2>/dev/null' TERM INT
wait -n "$api" "$worker" "$web"
code=$?
kill "$api" "$worker" "$web" 2>/dev/null
wait
exit "$code"
