#!/usr/bin/env bash

set -euo pipefail

cd "${0%/*}/.."
test_python=.venv/bin/python
if [[ ! -x "$test_python" && -f .venv/Scripts/python.exe ]]; then
  test_python=.venv/Scripts/python.exe
fi
[[ -x "$test_python" ]] || {
  printf 'Run ./scripts/setup_local.sh first.\n' >&2
  exit 1
}

"$test_python" -m pytest -q
if command -v pnpm >/dev/null 2>&1; then
  pnpm frontend:test
  pnpm frontend:typecheck
else
  corepack pnpm frontend:test
  corepack pnpm frontend:typecheck
fi
