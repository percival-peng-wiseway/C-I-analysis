#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

python_command="${PYTHON_BIN:-python3}"
"$python_command" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else "Python 3.12 or newer is required")'

if [[ ! -x .venv/bin/python ]]; then
  "$python_command" -m venv .venv
fi

.venv/bin/python -m pip install -e '.[dev]'

if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm install --frozen-lockfile
else
  printf 'Node.js with pnpm or corepack is required.\n' >&2
  exit 1
fi

printf '\nSetup complete. Start the app with: ./scripts/dev.sh\n'
