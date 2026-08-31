#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."
[[ -x .venv/bin/python ]] || {
  printf 'Run ./scripts/setup_local.sh first.\n' >&2
  exit 1
}

source scripts/local_env.sh
.venv/bin/python -m alembic -c alembic-ci.ini upgrade head

.venv/bin/python -m uvicorn api.ci_main:app --host 127.0.0.1 --port "$E3_API_PORT" &
api_process=$!

cleanup() {
  kill "$api_process" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf '\nE3 C&I Analyzer\nAPI: http://127.0.0.1:%s\nWeb: http://127.0.0.1:%s\n\n' "$E3_API_PORT" "$E3_WEB_PORT"

if command -v pnpm >/dev/null 2>&1; then
  pnpm --dir apps/web exec vite --host 127.0.0.1 --port "$E3_WEB_PORT" --strictPort
else
  corepack pnpm --dir apps/web exec vite --host 127.0.0.1 --port "$E3_WEB_PORT" --strictPort
fi
