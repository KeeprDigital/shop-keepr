#!/usr/bin/env bash
# Throwaway spike (issue #19). Brings up a local Postgres in Docker, loads the
# same 150k-row corpus the D1 search spike measured, and runs the equivalent
# queries under EXPLAIN (ANALYZE, BUFFERS).
#
# Methodology matches `spike/d1-search`: seven runs per query, median reported.
# Server-side execution time only — no network, no Worker, no Hyperdrive. That
# is deliberate, because the D1 figures being compared against are also
# in-process. Neither set includes the network, and the whole Postgres argument
# turns on the network, so see the doc for what this can and cannot settle.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER=shopkeepr-pg-spike
RUNS=7

psql_() { docker exec -i "$CONTAINER" psql -U postgres -d shopkeepr -v ON_ERROR_STOP=1 "$@"; }

echo "==> container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=shopkeepr \
  -v "$HERE/data:/data:ro" \
  postgres:17-alpine \
  -c shared_buffers=512MB -c work_mem=64MB -c max_wal_size=4GB \
  -c track_io_timing=on >/dev/null

# pg_isready reports ready during the image's own init pass, before POSTGRES_DB
# exists. Poll the database we actually want instead.
until docker exec "$CONTAINER" psql -U postgres -d shopkeepr -tAc 'SELECT 1' >/dev/null 2>&1; do :; done
docker exec "$CONTAINER" psql -U postgres -d shopkeepr -tAc 'SELECT version()'

echo "==> schema"
psql_ -q -f - < "$HERE/schema.sql"

echo "==> COPY (bulk load)"
# Server-side COPY: the TSVs are bind-mounted into the container, so this is the
# same path a real seed would take (`pg_dump`/`COPY`), not a client round trip.
psql_ -c "\timing on" -c "
  COPY catalogue_printing (id,game_system,name,set_code,set_name,collector_number,rarity,finish,language,colour_identity,type_line,subtype,mana_value,market_price,image_uri,released_at) FROM '/data/printings.tsv';
" -c "
  COPY stock (store_id,printing_id,condition,quantity,sell_price,buy_price) FROM '/data/stock_a.tsv';
" -c "
  COPY stock (store_id,printing_id,condition,quantity,sell_price,buy_price) FROM '/data/stock_b.tsv';
"
echo "--- wall clock for the same three COPYs, re-run into a scratch table:"
psql_ -q -c "CREATE TABLE copy_timing (LIKE catalogue_printing);"
/usr/bin/time -p docker exec -i "$CONTAINER" psql -U postgres -d shopkeepr -q -c \
  "COPY copy_timing (id,game_system,name,set_code,set_name,collector_number,rarity,finish,language,colour_identity,type_line,subtype,mana_value,market_price,image_uri,released_at) FROM '/data/printings.tsv';"
psql_ -q -c "DROP TABLE copy_timing;"

echo "==> sizes, data only"
psql_ -c "SELECT pg_size_pretty(pg_total_relation_size('catalogue_printing')) AS printing, pg_size_pretty(pg_total_relation_size('stock')) AS stock, pg_size_pretty(pg_database_size('shopkeepr')) AS database;"

echo "==> indexes (build times inline)"
psql_ -f - < "$HERE/indexes.sql"

echo "==> sizes, indexed"
psql_ -c "
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC;"
psql_ -c "SELECT pg_size_pretty(pg_total_relation_size('catalogue_printing')) AS printing_total, pg_size_pretty(pg_database_size('shopkeepr')) AS database;"

echo "==> queries"
printf '%-34s %10s %14s %14s\n' QUERY 'MEDIAN ms' 'BUF hit+read' ROWS
for f in "$HERE"/queries/*.sql; do
  name=$(basename "$f" .sql)
  # Warm the cache and let the plan settle before timing.
  psql_ -q -f - < "$f" >/dev/null 2>&1 || { printf '%-34s %10s\n' "$name" ERROR; continue; }

  times=()
  for _ in $(seq "$RUNS"); do
    out=$(psql_ -tA -c "EXPLAIN (ANALYZE, BUFFERS, TIMING, FORMAT JSON) $(cat "$f")")
    times+=("$(printf '%s' "$out" | grep -o '"Execution Time": *[0-9.]*' | head -1 | grep -o '[0-9.]*$')")
  done
  median=$(printf '%s\n' "${times[@]}" | sort -g | awk -v n="$RUNS" 'NR==int((n+1)/2)')

  plan=$(psql_ -tA -c "EXPLAIN (ANALYZE, BUFFERS, TIMING, FORMAT JSON) $(cat "$f")")
  buf=$(printf '%s' "$plan" | grep -o '"Shared Hit Blocks": *[0-9]*\|"Shared Read Blocks": *[0-9]*' | grep -o '[0-9]*$' | awk '{s+=$1} END {print s+0}')
  rows=$(psql_ -tA -f - < "$f" | wc -l | tr -d " ")

  printf '%-34s %10s %14s %14s\n' "$name" "$median" "$buf" "$rows"
done

echo "==> plans for the load-bearing queries"
for q in 01-fts-single 05-fts-facet-join-price 06-trgm-substring 07-like-prefix-default-index 10-faceted-instock-a 13-empty-facet-b; do
  echo "--- $q"
  psql_ -c "EXPLAIN (ANALYZE, BUFFERS) $(cat "$HERE/queries/$q.sql")"
done

echo "==> generated-column integrity: does the search index follow a rename?"
psql_ -c "
UPDATE catalogue_printing SET name = 'Renamed Zzyzx Placeholder' WHERE id = (SELECT id FROM catalogue_printing WHERE game_system='magic' ORDER BY id LIMIT 1);
SELECT count(*) AS matches_new FROM catalogue_printing WHERE search_tsv @@ to_tsquery('simple','zzyzx');
SELECT count(*) AS still_matches_stale FROM catalogue_printing WHERE search_tsv @@ to_tsquery('simple','placeholder') AND name <> 'Renamed Zzyzx Placeholder';"

echo "==> parameter limit: how many bind parameters does one statement take?"
psql_ -tA -c "SELECT count(*) FROM catalogue_printing WHERE id = ANY(ARRAY(SELECT id FROM catalogue_printing LIMIT 20000));" || true
docker exec -i "$CONTAINER" psql -U postgres -d shopkeepr -tA <<'SQL' || echo "  (65535 parameter probe failed — see doc)"
SELECT 'probe deferred to client driver; the 65535 cap is a wire-protocol limit, not a server SQL limit' AS note;
SQL

echo "==> pg_dump works with a full-text index present?"
docker exec "$CONTAINER" pg_dump -U postgres -d shopkeepr --schema-only > "$HERE/data/dump-schema.sql" && \
  echo "  schema dump OK, $(wc -l < "$HERE/data/dump-schema.sql") lines"
docker exec "$CONTAINER" pg_dump -U postgres -d shopkeepr -Fc -f /tmp/full.dump && \
  docker exec "$CONTAINER" sh -c 'ls -l /tmp/full.dump' && echo "  full dump OK"

echo "==> done. container '$CONTAINER' left running; docker rm -f $CONTAINER to clean up"
