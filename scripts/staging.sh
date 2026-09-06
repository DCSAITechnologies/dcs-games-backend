#!/usr/bin/env bash
# A7 — bring up the DCS Games staging environment on this machine.
# Staging is deliberately local: it is a second, disposable deployment target
# whose database is rebuilt purely from the migration chain, so promoting to it
# proves the migrations before anything touches production.
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/opt/libpq/bin:$PATH"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

: "${STAGING_DB:=dcs_games_staging}"
: "${STAGING_PORT:=8099}"
: "${PG_ADMIN:=postgresql://127.0.0.1:5432/postgres}"
STAGING_DSN="postgresql://127.0.0.1:5432/${STAGING_DB}"
DATA_DIR="${HERE}/.dcs-data/staging"

echo "==> rebuilding staging schema from the migration chain"
node scripts/migrate.mjs staging --admin "$PG_ADMIN" --db "$STAGING_DB"

echo "==> asserting the schema the code requires"
node scripts/migrate.mjs verify --dsn "$STAGING_DSN"

echo "==> starting the staging service on :${STAGING_PORT}"
mkdir -p "$DATA_DIR"
PAYMENTS_LIVE=0 \
DATABASE_URL="$STAGING_DSN" \
DCS_DATA_DIR="$DATA_DIR" \
DCS_AUTH_SECRET="${DCS_AUTH_SECRET:-staging-local-secret}" \
DCS_INTERNAL_TESTERS="${DCS_INTERNAL_TESTERS:-ndusadftb@gmail.com}" \
PORT="$STAGING_PORT" \
node --import tsx server.mts &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

for i in $(seq 1 60); do curl -sf "http://127.0.0.1:${STAGING_PORT}/health" >/dev/null && break; sleep 1; done

echo "==> post-deploy smoke"
node scripts/smoke.mjs "http://127.0.0.1:${STAGING_PORT}"

echo
echo "staging is up at http://127.0.0.1:${STAGING_PORT} (db: ${STAGING_DB}). Ctrl-C to stop."
wait $SRV
