#!/bin/sh

set -eu

: "${DATABASE_URL:?DATABASE_URL must be configured as a Worker secret}"
: "${DURABLE_API_BEARER_TOKEN:?DURABLE_API_BEARER_TOKEN must be configured as a Worker secret}"

case "$DATABASE_URL" in
  sqlite*)
    printf '%s\n' 'Cloudflare Containers require durable PostgreSQL; SQLite container disk is ephemeral.' >&2
    exit 1
    ;;
esac

if [ "${OBJECT_STORE_BACKEND:-}" != "http" ]; then
  printf '%s\n' 'Cloudflare Containers require the private HTTP-to-R2 object-store bridge.' >&2
  exit 1
fi

python -m alembic -c alembic-ci.ini upgrade head
exec python -m uvicorn api.ci_main:app --host 0.0.0.0 --port 8080
