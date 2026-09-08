#!/usr/bin/env bash
# Throwaway spike, issue #25 item 1. Local Postgres in Docker. Nothing hosted,
# nothing provisioned, no account, no money.
#
# Loads 150,000 Printings with REAL card names, builds a pg_trgm GIN index and a
# pg_trgm GiST index, and asks the one question #25 item 1 actually poses: does
# GiST plus `<->` make the planner use the index under `ORDER BY ... LIMIT`,
# which #19 measured it declining?
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER=shopkeepr-pgtrgm-spike

psql_() { docker exec -i "$CONTAINER" psql -U postgres -d shopkeepr -v ON_ERROR_STOP=1 "$@"; }

echo "==> container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=shopkeepr \
  -v "$HERE/data:/data:ro" \
  postgres:17-alpine \
  -c shared_buffers=512MB -c work_mem=64MB -c max_wal_size=4GB \
  -c track_io_timing=on >/dev/null

until docker exec "$CONTAINER" psql -U postgres -d shopkeepr -tAc 'SELECT 1' >/dev/null 2>&1; do :; done

echo "==> schema"
psql_ -q <<'SQL'
CREATE TABLE catalogue_printing (
  id            text PRIMARY KEY,
  game_system   text NOT NULL,
  name          text NOT NULL,
  name_folded   text NOT NULL,
  rarity        text NOT NULL,
  market_price  integer NOT NULL
);
SQL

echo "==> COPY"
psql_ -c "\timing on" -c "COPY catalogue_printing FROM '/data/printings.tsv';"

echo "==> indexes (each timed separately)"
psql_ -c "\timing on" \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;" \
  -c "CREATE INDEX cp_game ON catalogue_printing (game_system, name_folded);" \
  -c "CREATE INDEX cp_name_trgm_gin ON catalogue_printing USING GIN (name gin_trgm_ops);" \
  -c "CREATE INDEX cp_folded_trgm_gin ON catalogue_printing USING GIN (name_folded gin_trgm_ops);" \
  -c "CREATE INDEX cp_name_trgm_gist ON catalogue_printing USING GIST (name gist_trgm_ops);" \
  -c "CREATE INDEX cp_folded_trgm_gist ON catalogue_printing USING GIST (name_folded gist_trgm_ops);" \
  -c "VACUUM ANALYZE catalogue_printing;"

echo "==> probes"
psql_ -f - < "$HERE/probes.sql"

echo
echo "Container '$CONTAINER' left running. Remove with: docker rm -f $CONTAINER"
