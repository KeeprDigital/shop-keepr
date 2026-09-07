/**
 * Throwaway spike (issue #13), part 1: what D1 will and will not let you do.
 *
 * Every test here is a capability probe. They are deliberately self-contained —
 * each creates and drops what it needs — so nothing depends on test ordering or
 * on whether the pool isolates storage between tests.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const DB = env.DB;

/** Runs a statement and returns either its result or the error message, so a probe can assert on a rejection. */
async function probe(sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await DB.prepare(sql).run();
		return { ok: true };
	}
	catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

describe('sQLite build', () => {
	it('cannot be asked its version', async () => {
		// Recorded as a finding, not a failure: D1's authorizer refuses the
		// introspection functions, so the SQLite version is unobtainable from
		// inside a query as well as being undocumented.
		let error = '';
		try {
			const row = await DB.prepare('SELECT sqlite_version() AS v').first<{ v: string }>();
			console.log(`[build] sqlite_version() = ${row?.v}`);
		}
		catch (e) {
			error = e instanceof Error ? e.message : String(e);
			console.log(`[build] sqlite_version() -> ${error}`);
		}
		expect(error).toContain('not authorized');
	});

	it('reports its compile options where exposed', async () => {
		for (const opt of ['ENABLE_FTS5', 'ENABLE_FTS4', 'ENABLE_RTREE', 'ENABLE_DBSTAT_VTAB', 'ENABLE_STAT4']) {
			try {
				const row = await DB.prepare(`SELECT sqlite_compileoption_used('${opt}') AS used`).first<{ used: number }>();
				console.log(`[build] compileoption ${opt} = ${row?.used}`);
			}
			catch (e) {
				console.log(`[build] compileoption ${opt} -> ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	});
});

describe('cross-database access (ticket #13 claim 2)', () => {
	it('rejects ATTACH', async () => {
		const r = await probe('ATTACH DATABASE \'other.db\' AS other');
		console.log(`[attach] ATTACH -> ${r.ok ? 'ALLOWED' : r.error}`);
		expect(r.ok).toBe(false);
	});

	it('rejects DETACH', async () => {
		const r = await probe('DETACH DATABASE other');
		console.log(`[attach] DETACH -> ${r.ok ? 'ALLOWED' : r.error}`);
		expect(r.ok).toBe(false);
	});

	it('rejects a schema-qualified reference to another database', async () => {
		const r = await probe('SELECT * FROM other.some_table');
		console.log(`[attach] qualified read -> ${r.ok ? 'ALLOWED' : r.error}`);
		expect(r.ok).toBe(false);
	});

	it('rejects temp objects, which rules out staging a cross-database copy in temp', async () => {
		for (const sql of [
			'CREATE TEMP TABLE t_probe (a TEXT)',
			'CREATE TEMPORARY VIEW v_probe AS SELECT 1',
		]) {
			const r = await probe(sql);
			console.log(`[temp] ${sql} -> ${r.ok ? 'ALLOWED' : r.error}`);
			expect(r.ok).toBe(false);
		}
	});
});

describe('fTS5 (ticket #13 claim 1)', () => {
	it('creates an FTS5 virtual table with the default tokenizer', async () => {
		await DB.exec('DROP TABLE IF EXISTS fts_default;');
		const r = await probe('CREATE VIRTUAL TABLE fts_default USING fts5(name, type_line)');
		console.log(`[fts5] default -> ${r.ok ? 'OK' : r.error}`);
		expect(r.ok).toBe(true);

		await DB.prepare('INSERT INTO fts_default (name, type_line) VALUES (?1, ?2)')
			.bind('Thundering Sentinel of Storms', 'Creature — Human Soldier')
			.run();
		const hit = await DB.prepare('SELECT name FROM fts_default WHERE fts_default MATCH ?1')
			.bind('sentinel')
			.first<{ name: string }>();
		console.log(`[fts5] MATCH hit = ${hit?.name}`);
		expect(hit?.name).toContain('Sentinel');
		await DB.exec('DROP TABLE IF EXISTS fts_default;');
	});

	it('reports which tokenizers the build accepts', async () => {
		const results: Record<string, string> = {};
		for (const tokenize of ['unicode61', 'ascii', 'porter', 'trigram', 'porter unicode61', 'trigram case_sensitive 0']) {
			await DB.exec('DROP TABLE IF EXISTS fts_tok;');
			const r = await probe(`CREATE VIRTUAL TABLE fts_tok USING fts5(name, tokenize='${tokenize}')`);
			results[tokenize] = r.ok ? 'OK' : r.error;
			console.log(`[fts5] tokenize='${tokenize}' -> ${results[tokenize]}`);
		}
		await DB.exec('DROP TABLE IF EXISTS fts_tok;');
		// unicode61 is the FTS5 default and must work if FTS5 works at all.
		expect(results.unicode61).toBe('OK');
	});

	it('supports prefix indexes, external content, and contentless-delete', async () => {
		const variants: Array<[string, string]> = [
			['prefix', 'CREATE VIRTUAL TABLE fts_v USING fts5(name, prefix=\'2 3\')'],
			['contentless', 'CREATE VIRTUAL TABLE fts_v USING fts5(name, content=\'\')'],
			['contentless_delete', 'CREATE VIRTUAL TABLE fts_v USING fts5(name, content=\'\', contentless_delete=1)'],
			['columnsize=0', 'CREATE VIRTUAL TABLE fts_v USING fts5(name, columnsize=0)'],
		];
		for (const [label, sql] of variants) {
			await DB.exec('DROP TABLE IF EXISTS fts_v;');
			const r = await probe(sql);
			console.log(`[fts5] ${label} -> ${r.ok ? 'OK' : r.error}`);
		}

		// External content needs a real base table.
		await DB.exec('DROP TABLE IF EXISTS fts_v;');
		await DB.exec('DROP TABLE IF EXISTS base_probe;');
		await DB.exec('CREATE TABLE base_probe (id INTEGER PRIMARY KEY, name TEXT);');
		const ext = await probe('CREATE VIRTUAL TABLE fts_v USING fts5(name, content=\'base_probe\', content_rowid=\'id\')');
		console.log(`[fts5] external content -> ${ext.ok ? 'OK' : ext.error}`);
		expect(ext.ok).toBe(true);

		// Triggers are how an external-content index is kept in sync; check they exist.
		const trig = await probe(
			'CREATE TRIGGER base_probe_ai AFTER INSERT ON base_probe BEGIN INSERT INTO fts_v (rowid, name) VALUES (new.id, new.name); END',
		);
		console.log(`[fts5] sync trigger -> ${trig.ok ? 'OK' : trig.error}`);

		if (trig.ok) {
			await DB.prepare('INSERT INTO base_probe (name) VALUES (?1)').bind('Verdant Oracle').run();
			const hit = await DB.prepare('SELECT name FROM fts_v WHERE fts_v MATCH ?1').bind('verdant').first<{ name: string }>();
			console.log(`[fts5] trigger-synced MATCH = ${hit?.name}`);
			expect(hit?.name).toBe('Verdant Oracle');
		}

		await DB.exec('DROP TABLE IF EXISTS fts_v;');
		await DB.exec('DROP TABLE IF EXISTS base_probe;');
	});

	it('supports the auxiliary functions a ranked search needs', async () => {
		await DB.exec('DROP TABLE IF EXISTS fts_aux;');
		await DB.exec('CREATE VIRTUAL TABLE fts_aux USING fts5(name);');
		await DB.prepare('INSERT INTO fts_aux (name) VALUES (?1), (?2)')
			.bind('Radiant Sentinel', 'Sentinel of the Deep')
			.run();
		for (const [label, sql] of [
			['bm25', 'SELECT name, bm25(fts_aux) AS r FROM fts_aux WHERE fts_aux MATCH \'sentinel\' ORDER BY r'],
			['rank', 'SELECT name FROM fts_aux WHERE fts_aux MATCH \'sentinel\' ORDER BY rank'],
			['snippet', 'SELECT snippet(fts_aux, 0, \'[\', \']\', \'…\', 8) AS s FROM fts_aux WHERE fts_aux MATCH \'sentinel\''],
			['highlight', 'SELECT highlight(fts_aux, 0, \'[\', \']\') AS h FROM fts_aux WHERE fts_aux MATCH \'sentinel\''],
			['prefix query', 'SELECT name FROM fts_aux WHERE fts_aux MATCH \'sent*\''],
			['phrase query', 'SELECT name FROM fts_aux WHERE fts_aux MATCH \'"of the deep"\''],
		] as Array<[string, string]>) {
			try {
				const res = await DB.prepare(sql).all();
				console.log(`[fts5] ${label} -> OK, ${res.results.length} rows, first = ${JSON.stringify(res.results[0])}`);
			}
			catch (e) {
				console.log(`[fts5] ${label} -> ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// fts5vocab, two-argument form (the three-argument form needs temp, which D1 forbids).
		await DB.exec('DROP TABLE IF EXISTS fts_aux_vocab;');
		const vocab = await probe('CREATE VIRTUAL TABLE fts_aux_vocab USING fts5vocab(fts_aux, \'row\')');
		console.log(`[fts5] fts5vocab(2-arg) -> ${vocab.ok ? 'OK' : vocab.error}`);
		if (vocab.ok) {
			const row = await DB.prepare('SELECT term, doc, cnt FROM fts_aux_vocab ORDER BY cnt DESC LIMIT 1').first();
			console.log(`[fts5] fts5vocab top term = ${JSON.stringify(row)}`);
		}
		await DB.exec('DROP TABLE IF EXISTS fts_aux_vocab;');
		await DB.exec('DROP TABLE IF EXISTS fts_aux;');
	});

	it('records whether other virtual table modules are refused', async () => {
		for (const mod of ['fts4', 'fts3', 'rtree', 'dbstat', 'csv']) {
			await DB.exec('DROP TABLE IF EXISTS vt_probe;');
			const r = await probe(`CREATE VIRTUAL TABLE vt_probe USING ${mod}(a, b)`);
			console.log(`[vtab] ${mod} -> ${r.ok ? 'ALLOWED' : r.error}`);
		}
		await DB.exec('DROP TABLE IF EXISTS vt_probe;');
	});
});

describe('documented limits, measured', () => {
	it('finds the real bound-parameter ceiling', async () => {
		let last = 0;
		for (const n of [50, 99, 100, 101, 120, 200]) {
			const sql = `SELECT ${Array.from({ length: n }, (_, i) => `?${i + 1}`).join(' , ')}`;
			try {
				await DB.prepare(sql).bind(...Array.from({ length: n }, () => 1)).first();
				last = n;
				console.log(`[limit] ${n} bound parameters -> OK`);
			}
			catch (e) {
				console.log(`[limit] ${n} bound parameters -> ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		console.log(`[limit] highest bound-parameter count accepted = ${last}`);
	});

	it('finds the real SQL statement-length ceiling', async () => {
		await DB.exec('DROP TABLE IF EXISTS len_probe;');
		await DB.exec('CREATE TABLE len_probe (a TEXT);');
		for (const bytes of [50_000, 99_000, 100_000, 120_000, 500_000, 1_000_000]) {
			const filler = 'x'.repeat(Math.max(0, bytes - 40));
			const sql = `INSERT INTO len_probe (a) VALUES ('${filler}')`;
			try {
				await DB.prepare(sql).run();
				console.log(`[limit] statement of ${sql.length} bytes -> OK`);
			}
			catch (e) {
				console.log(`[limit] statement of ${sql.length} bytes -> ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		await DB.exec('DROP TABLE IF EXISTS len_probe;');
	});

	it('finds the compound-SELECT ceiling, which the docs do not publish', async () => {
		for (const n of [2, 5, 6, 10]) {
			const sql = Array.from({ length: n }, (_, i) => `SELECT ${i} AS a`).join(' UNION ALL ');
			const r = await probe(sql);
			console.log(`[limit] ${n}-term UNION ALL -> ${r.ok ? 'OK' : r.error}`);
		}
	});
});
