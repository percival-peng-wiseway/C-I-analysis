#!/usr/bin/env bash

set -euo pipefail

export DATABASE_URL="${DATABASE_URL:-sqlite+pysqlite:///./.local/e3_ci_analyzer.sqlite3}"
export OBJECT_STORE_ROOT="${OBJECT_STORE_ROOT:-.local/object_store}"
export CI_TARIFF_PROFILE_PATH="${CI_TARIFF_PROFILE_PATH:-.local/ci/active-tariff-profile.json}"
export DURABLE_API_AUTH_MODE="${DURABLE_API_AUTH_MODE:-loopback_development}"
export DURABLE_API_BEARER_TOKEN="${DURABLE_API_BEARER_TOKEN:-ci-local-development-only}"
export LOCAL_WORKSPACE_ID="${LOCAL_WORKSPACE_ID:-local-workspace}"
export LOCAL_OWNER_ID="${LOCAL_OWNER_ID:-local-analyst}"
export LOCAL_ACTOR_ID="${LOCAL_ACTOR_ID:-local-analyst}"
export LOCAL_ACTOR_DISPLAY_NAME="${LOCAL_ACTOR_DISPLAY_NAME:-Local analyst}"
export E3_API_PORT="${E3_API_PORT:-18080}"
export E3_WEB_PORT="${E3_WEB_PORT:-15173}"
export API_PROXY_TARGET="${API_PROXY_TARGET:-http://127.0.0.1:${E3_API_PORT}}"

mkdir -p .local/object_store .local/ci
