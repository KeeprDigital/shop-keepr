#!/usr/bin/env bash
# One probe per process: the Turso Database engine segfaults on at least one
# input (see README), and a shared process would lose every later result.
set -u
cd "$(dirname "$0")"

while IFS='|' read -r label sql; do
	out=$(node probe-turso-one.mjs "$sql" </dev/null 2>&1 | tail -1)
	[ -z "$out" ] && out="*** CRASHED (no output, killed by signal) ***"
	printf '%-30s %s\n' "$label" "$out"
done <<'EOF'
sqlite_version()|SELECT sqlite_version() AS v
ATTACH DATABASE|ATTACH DATABASE 'other.db' AS other
CREATE TEMP TABLE|CREATE TEMP TABLE t (a TEXT)
CREATE TEMPORARY VIEW|CREATE TEMPORARY VIEW v AS SELECT 1
fts5 default|CREATE VIRTUAL TABLE f1 USING fts5(name)
fts5 trigram|CREATE VIRTUAL TABLE f4 USING fts5(name, tokenize='trigram')
fts5 external content|CREATE VIRTUAL TABLE f8 USING fts5(name, content='base', content_rowid='id')
fts4|CREATE VIRTUAL TABLE g1 USING fts4(name)
rtree|CREATE VIRTUAL TABLE g3 USING rtree(id, minX, maxX)
Turso FTS (USING fts)|CREATE INDEX base_fts ON base USING fts (name)
generated STORED|CREATE TABLE gen (a INT, b INT GENERATED ALWAYS AS (a*2) STORED)
partial index|CREATE INDEX pidx ON base (name) WHERE name IS NOT NULL
CREATE TRIGGER|CREATE TRIGGER tr AFTER INSERT ON base BEGIN UPDATE base SET name=name WHERE id=NEW.id; END
WITH RECURSIVE|WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT sum(x) AS s FROM c
window lag()|SELECT lag(id) OVER (ORDER BY id) AS l FROM base
window row_number()|SELECT row_number() OVER (ORDER BY id) AS r FROM base
COLLATE NOCASE index|CREATE INDEX nidx ON base (name COLLATE NOCASE)
STRICT table|CREATE TABLE st (a INT) STRICT
UPSERT|INSERT INTO base (id,name) VALUES (1,'x') ON CONFLICT(id) DO UPDATE SET name='y'
RETURNING|INSERT INTO base (id,name) VALUES (98,'z') RETURNING id
PRAGMA optimize|PRAGMA optimize
BEGIN CONCURRENT|BEGIN CONCURRENT
EOF

echo
echo "--- numeric ceilings ---"
for n in 100 101 500 1000 5000; do
	r=$(node ceilings-turso.mjs params "$n" </dev/null 2>&1 | tail -1)
	echo "bound params      $n -> ${r:-CRASHED}"
done
for n in 5 6 100 500 1000 5000; do
	r=$(node ceilings-turso.mjs compound "$n" </dev/null 2>&1 | tail -1)
	echo "compound SELECT   $n -> ${r:-CRASHED}"
done
