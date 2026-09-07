\timing on
\echo '--- P1: trigram substring WITHOUT ORDER BY (is the GIN trgm index used?)'
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name FROM catalogue_printing WHERE name ILIKE '%entine%' LIMIT 20;

\echo '--- P2: trigram substring, unlimited count (forces the index)'
EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM catalogue_printing WHERE name ILIKE '%entine%';

\echo '--- P3: prefix LIKE with text_pattern_ops index DROPPED (the D1 trap, Postgres edition)'
DROP INDEX cp_name_pattern;
EXPLAIN (ANALYZE, BUFFERS) SELECT id, name FROM catalogue_printing WHERE game_system = 'magic' AND name LIKE 'Thundering Sent%' ORDER BY name LIMIT 20;
CREATE INDEX cp_name_pattern ON catalogue_printing (name text_pattern_ops);

\echo '--- P4: write cost of the generated tsvector + GIN + trgm (single row update, as the delta sync does)'
EXPLAIN (ANALYZE, BUFFERS) UPDATE catalogue_printing SET market_price = market_price + 1 WHERE id = (SELECT id FROM catalogue_printing ORDER BY id LIMIT 1);
\echo '--- P5: a 2000-row market-price delta, the shape #13 measured on D1 (4000 rows_written there)'
EXPLAIN (ANALYZE, BUFFERS) UPDATE catalogue_printing SET market_price = market_price + 1 WHERE id IN (SELECT id FROM catalogue_printing WHERE game_system='magic' ORDER BY id LIMIT 2000);
\echo '--- P6: a name change on 2000 rows, which DOES touch the tsvector and both GIN indexes'
EXPLAIN (ANALYZE, BUFFERS) UPDATE catalogue_printing SET name = name || ' X' WHERE id IN (SELECT id FROM catalogue_printing WHERE game_system='pokemon' ORDER BY id LIMIT 2000);

\echo '--- P7: interactive transaction, read-then-decide-then-write under a row lock (the thing D1 cannot do)'
BEGIN;
SELECT id, quantity FROM stock WHERE store_id='store-a' ORDER BY id LIMIT 1 FOR UPDATE;
UPDATE stock SET quantity = quantity - 1 WHERE id = (SELECT id FROM stock WHERE store_id='store-a' ORDER BY id LIMIT 1) AND quantity >= 1;
COMMIT;

\echo '--- P8: compound SELECT terms (D1 caps at 5, undocumented)'
SELECT count(*) FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9 UNION ALL SELECT 10) t;

\echo '--- P9: index sizes after the writes'
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size FROM pg_stat_user_indexes ORDER BY pg_relation_size(indexrelid) DESC LIMIT 4;
