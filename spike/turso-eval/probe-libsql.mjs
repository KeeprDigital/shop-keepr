// Capability probe: run the D1 spike's matrix against libSQL and Turso Database.
import { createClient } from '@libsql/client';
import { rmSync } from 'node:fs';

const PROBES = [
	['sqlite_version()', `SELECT sqlite_version() AS v`],
	['ATTACH DATABASE', `ATTACH DATABASE 'other.db' AS other`],
	['CREATE TEMP TABLE', `CREATE TEMP TABLE t (a TEXT)`],
	['CREATE TEMPORARY VIEW', `CREATE TEMPORARY VIEW v AS SELECT 1`],
	['fts5 default', `CREATE VIRTUAL TABLE f1 USING fts5(name)`],
	['fts5 unicode61', `CREATE VIRTUAL TABLE f2 USING fts5(name, tokenize='unicode61')`],
	['fts5 porter', `CREATE VIRTUAL TABLE f3 USING fts5(name, tokenize='porter')`],
	['fts5 trigram', `CREATE VIRTUAL TABLE f4 USING fts5(name, tokenize='trigram')`],
	['fts5 prefix=', `CREATE VIRTUAL TABLE f5 USING fts5(name, prefix='2 3')`],
	['fts5 contentless', `CREATE VIRTUAL TABLE f6 USING fts5(name, content='')`],
	['fts5 contentless_delete', `CREATE VIRTUAL TABLE f7 USING fts5(name, content='', contentless_delete=1)`],
	['fts5 external content', `CREATE VIRTUAL TABLE f8 USING fts5(name, content='base', content_rowid='id')`],
	['fts4', `CREATE VIRTUAL TABLE g1 USING fts4(name)`],
	['fts3', `CREATE VIRTUAL TABLE g2 USING fts3(name)`],
	['rtree', `CREATE VIRTUAL TABLE g3 USING rtree(id, minX, maxX)`],
	['dbstat', `CREATE VIRTUAL TABLE g4 USING dbstat`],
	['fts5vocab 2-arg', `CREATE VIRTUAL TABLE g5 USING fts5vocab(f1, 'row')`],
	['Turso FTS (USING fts)', `CREATE INDEX base_fts ON base USING fts (name)`],
	['generated STORED', `CREATE TABLE gen (a INT, b INT GENERATED ALWAYS AS (a*2) STORED)`],
	['partial index', `CREATE INDEX pidx ON base (name) WHERE name IS NOT NULL`],
	['CREATE TRIGGER', `CREATE TRIGGER tr AFTER INSERT ON base BEGIN UPDATE base SET name=name WHERE id=NEW.id; END`],
	['WITH RECURSIVE', `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT sum(x) FROM c`],
	['window fn lag()', `SELECT lag(id) OVER (ORDER BY id) FROM base`],
	['window fn row_number()', `SELECT row_number() OVER (ORDER BY id) FROM base`],
	['COLLATE NOCASE index', `CREATE INDEX nidx ON base (name COLLATE NOCASE)`],
	['STRICT table', `CREATE TABLE st (a INT) STRICT`],
	['UPSERT', `INSERT INTO base (id,name) VALUES (99,'x') ON CONFLICT(id) DO UPDATE SET name='y'`],
	['RETURNING', `INSERT INTO base (id,name) VALUES (98,'z') RETURNING id`],
	['PRAGMA optimize', `PRAGMA optimize`],
	['BEGIN CONCURRENT', `BEGIN CONCURRENT`],
];

function boundParamProbe(n) {
	const q = `SELECT ${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(',')}`;
	return [q, Array.from({ length: n }, (_, i) => i)];
}

function compoundProbe(n) {
	return Array.from({ length: n }, () => 'SELECT 1').join(' UNION ALL ');
}

async function runLibsql() {
	rmSync('/tmp/probe-libsql.db', { force: true });
	rmSync('/tmp/probe-libsql.db-wal', { force: true });
	const db = createClient({ url: 'file:/tmp/probe-libsql.db' });
	await db.execute(`CREATE TABLE base (id INTEGER PRIMARY KEY, name TEXT)`);
	await db.execute(`INSERT INTO base VALUES (1,'Thundering Sentinel')`);
	const out = {};
	for (const [label, sql] of PROBES) {
		try {
			const r = await db.execute(sql);
			out[label] = `OK${r.rows?.[0] ? ` -> ${JSON.stringify(r.rows[0])}` : ''}`;
		}
		catch (e) { out[label] = `FAIL: ${String(e.message ?? e).slice(0, 110)}`; }
	}
	// numeric ceilings
	out['bound params'] = await ceiling(async n => {
		const [q, a] = boundParamProbe(n);
		await db.execute({ sql: q, args: a });
	});
	out['compound SELECT terms'] = await ceiling(async n => { await db.execute(compoundProbe(n)); });
	out['statement length'] = await ceiling(async n => {
		await db.execute(`SELECT '${'a'.repeat(n)}'`);
	}, [1e5, 1e6, 5e6, 1e7, 5e7]);
	return out;
}

async function ceiling(fn, candidates = [5, 6, 10, 50, 100, 101, 500, 1000, 5000, 32766, 32767, 100000]) {
	let last = 'none passed';
	for (const n of candidates) {
		try { await fn(n); last = `>= ${n}`; }
		catch (e) { return `${last}, fails at ${n}: ${String(e.message ?? e).slice(0, 70)}`; }
	}
	return `${last} (no failure found)`;
}


console.log(JSON.stringify(await runLibsql().catch(e=>({ERROR:String(e)})),null,1));
