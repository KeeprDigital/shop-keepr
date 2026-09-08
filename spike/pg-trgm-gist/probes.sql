-- Issue #25 item 1. The specific unknown: #19 measured the planner DECLINING a
-- trigram index under `ORDER BY ... LIMIT`. Does GiST plus the `<->` distance
-- operator fix it? Everything below is EXPLAIN (ANALYZE, BUFFERS) so the plan is
-- reported alongside the time, because the plan is the actual question.

\timing on
\pset pager off

SELECT version();
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
SELECT count(*) AS printings, count(DISTINCT name) AS distinct_names FROM catalogue_printing;

\echo ''
\echo '=================== INDEX SIZES AND BUILD ==================='
SELECT indexrelname AS index, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes WHERE relname = 'catalogue_printing' ORDER BY pg_relation_size(indexrelid) DESC;
SELECT pg_size_pretty(pg_total_relation_size('catalogue_printing')) AS total_with_indexes,
       pg_size_pretty(pg_relation_size('catalogue_printing')) AS heap_only;

\echo ''
\echo '=================== 1. GIN + % FILTER (what #19 had) ==================='
\echo '-- similarity filter, NO ordering. GIN serves this.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing WHERE name % 'Lighming Bolt' LIMIT 20;

\echo ''
\echo '-- #19 SHAPE: similarity filter AND ordered by similarity, with LIMIT.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name, similarity(name, 'Lighming Bolt') AS s
FROM catalogue_printing WHERE name % 'Lighming Bolt'
ORDER BY s DESC LIMIT 20;

\echo ''
\echo '-- The pathological shape: ORDER BY similarity() with NO % filter.'
\echo '-- No index can serve this; it is a full sort. Included to show the trap.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing
ORDER BY similarity(name, 'Lighming Bolt') DESC LIMIT 20;

\echo ''
\echo '=================== 2. GiST + <-> DISTANCE ORDER (the question) ==================='
\echo '-- THE query #25 asks about: ORDER BY name <-> query LIMIT n.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name, name <-> 'Lighming Bolt' AS d
FROM catalogue_printing ORDER BY name <-> 'Lighming Bolt' LIMIT 20;

\echo ''
\echo '-- The same on the FOLDED column, which is what the app would actually store.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name, name_folded <-> 'lighming bolt' AS d
FROM catalogue_printing ORDER BY name_folded <-> 'lighming bolt' LIMIT 20;

\echo ''
\echo '-- GAME-SCOPED. Every storefront query is scoped to one Game System (#6).'
\echo '-- This is where a GiST distance order and an equality predicate must combine.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing WHERE game_system = 'magic'
ORDER BY name_folded <-> 'lighming bolt' LIMIT 20;

\echo ''
\echo '-- Game-scoped with a % filter as well, so the scan can stop.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing
WHERE game_system = 'magic' AND name_folded % 'lighming bolt'
ORDER BY name_folded <-> 'lighming bolt' LIMIT 20;

\echo ''
\echo '=================== 3. THE EXACT-HIT PATH IT SITS BEHIND ==================='
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing WHERE game_system = 'magic' AND name_folded = 'lightning bolt' LIMIT 20;

\echo ''
\echo '-- A MISS on the folded column: what actually triggers the fallback.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing WHERE game_system = 'magic' AND name_folded = 'lighming bolt' LIMIT 20;

\echo ''
\echo '=================== 4. TYPEAHEAD: a partial word mid-typing ==================='
\echo '-- word_similarity / <<-> is the operator for "query is a word inside the name".'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing ORDER BY name_folded <<-> 'lightnin' LIMIT 20;

\echo ''
\echo '-- strict_word_similarity / <<<-> , which anchors to word boundaries.'
EXPLAIN (ANALYZE, BUFFERS, TIMING ON)
SELECT id, name FROM catalogue_printing ORDER BY name_folded <<<-> 'lightnin' LIMIT 20;

\echo ''
\echo '=================== 5. THRESHOLD SENSITIVITY ==================='
SHOW pg_trgm.similarity_threshold;
SELECT 'default 0.3' AS setting, count(*) FROM catalogue_printing WHERE name_folded % 'lighming bolt';
SET pg_trgm.similarity_threshold = 0.5;
SELECT '0.5' AS setting, count(*) FROM catalogue_printing WHERE name_folded % 'lighming bolt';
SET pg_trgm.similarity_threshold = 0.15;
SELECT '0.15' AS setting, count(*) FROM catalogue_printing WHERE name_folded % 'lighming bolt';
RESET pg_trgm.similarity_threshold;

\echo ''
\echo '=================== 6. DOES IT ACTUALLY FIND THE RIGHT CARD? ==================='
\echo '-- Correctness, not speed. Five real misspellings of real card names.'
SELECT q.typo, (
  SELECT string_agg(x.name, ' | ' ORDER BY x.d)
  FROM (SELECT DISTINCT name, name_folded <-> q.typo AS d FROM catalogue_printing
        ORDER BY name_folded <-> q.typo LIMIT 3) x
) AS top3
FROM (VALUES
  ('lighming bolt'), ('farfetchd'), ('kozuki oden'), ('bell mere'), ('sheldred'), ('kaisa'), ('flabebe')
) AS q(typo);
