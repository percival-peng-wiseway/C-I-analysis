#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."
[[ -x .venv/bin/python ]] || {
  printf 'Run ./scripts/setup_local.sh first.\n' >&2
  exit 1
}

.venv/bin/python -m pytest -q
if command -v pnpm >/dev/null 2>&1; then
  pnpm frontend:test
  pnpm frontend:typecheck
else
  corepack pnpm frontend:test
  corepack pnpm frontend:typecheck
fi
