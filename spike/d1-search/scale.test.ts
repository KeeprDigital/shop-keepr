/**
 * Throwaway spike (issue #13), part 2: does a faceted storefront search hold up
 * at the volume issue #6 commits to?
 *
 * ~150k Catalogue rows plus a few thousand stock rows, in one D1 database, with
 * the queries the storefront would actually issue. Every number printed here is
 * measured, not estimated. `meta.rows_read` is what D1 bills on, so it is
 * reported alongside latency throughout.
 *
 * The whole run lives in one `it()` because the corpus takes minutes to build
 * and nothing here needs isolation from anything else.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	FACET_COUNT,
	FACET_COUNT_IN_STOCK,
	FACETED_BROWSE,
	FACETED_BROWSE_DEEP,
	FACETED_BROWSE_MULTI,
	FACETED_DENORM,
	FACETED_IN_STOCK,
	FACETED_IN_STOCK_ATP,
	FULL_SCAN_CONTROL,
	NAME_FTS,
	NAME_FTS_FACETED_IN_STOCK,
	NAME_LIKE_PREFIX,
	NAME_LIKE_SUBSTRING,
} from './queries';
import { BASE_SCHEMA, COVERING_INDEX, DENORM, DENORM_INDEX, INDEXES, PARTIAL_INDEX } from './schema';
import {
	generatePrintings,
	generateStock,
	lit,
	packStatements,
	PRINTING_INSERT_PREFIX,
	printingValues,
	TOTAL_PRINTINGS,
} from './seed';

const DB = env.DB;

/** Batches to send at once. D1 caps a Worker invocation at 1,000 queries; this stays well under. */
const BATCH_STATEMENTS = 200;
/** Headroom under D1's documented 100,000-byte statement limit. */
const MAX_STATEMENT_BYTES = 90_000;
const STORE_ID = 'store-001';
const STOCK_SKUS = 4_000;

interface Measured {
	label: string;
	medianMs: number;
	minMs: number;
	maxMs: number;
	rowsRead: number;
	rowsReturned: number;
}

const measurements: Measured[] = [];

/** Runs a query `runs` times and reports the median wall-clock latency and D1's own `rows_read`. */
async function measure(label: string, sql: string, params: unknown[] = [], runs = 7): Promise<Measured> {
	const times: number[] = [];
	let rowsRead = 0;
	let rowsReturned = 0;
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		const res = await DB.prepare(sql).bind(...params).all();
		times.push(performance.now() - t0);
		rowsRead = (res.meta as { rows_read?: number }).rows_read ?? -1;
		rowsReturned = res.results.length;
	}
	times.sort((a, b) => a - b);
	const m: Measured = {
		label,
		medianMs: times[Math.floor(times.length / 2)]!,
		minMs: times[0]!,
		maxMs: times[times.length - 1]!,
		rowsRead,
		rowsReturned,
	};
	measurements.push(m);
	console.log(
		`[query] ${label.padEnd(44)} median ${m.medianMs.toFixed(2)}ms  (min ${m.minMs.toFixed(2)} / max ${m.maxMs.toFixed(2)})  rows_read=${m.rowsRead}  returned=${m.rowsReturned}`,
	);
	return m;
}

async function plan(label: string, sql: string, params: unknown[] = []): Promise<void> {
	const res = await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
	console.log(`[plan]  ${label}`);
	for (const row of res.results) console.log(`          ${row.detail}`);
}

/** D1 reports the database file size after every statement; that is how bytes-per-row gets measured. */
async function databaseBytes(): Promise<number> {
	const res = await DB.prepare('SELECT 1').all();
	return (res.meta as { size_after?: number }).size_after ?? -1;
}

async function runBatches(statements: string[], label: string): Promise<{ ms: number; rowsWritten: number }> {
	const t0 = performance.now();
	let rowsWritten = 0;
	for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
		const chunk = statements.slice(i, i + BATCH_STATEMENTS).map(s => DB.prepare(s));
		const results = await DB.batch(chunk);
		for (const r of results) rowsWritten += (r.meta as { rows_written?: number }).rows_written ?? 0;
	}
	const ms = performance.now() - t0;
	console.log(`[load]  ${label}: ${statements.length} statements in ${(ms / 1000).toFixed(1)}s, rows_written=${rowsWritten}`);
	return { ms, rowsWritten };
}

describe('faceted search at catalogue scale (ticket #13 claim 3)', () => {
	it('measures the whole thing', async () => {
		// ---------------------------------------------------------------
		// Build the corpus
		// ---------------------------------------------------------------
		const tGen = performance.now();
		const printings = generatePrintings();
		const stock = generateStock(printings, STOCK_SKUS, STORE_ID);
		console.log(`[seed]  generated ${printings.length} printings + ${stock.length} stock rows in ${((performance.now() - tGen) / 1000).toFixed(1)}s`);
		expect(printings.length).toBe(TOTAL_PRINTINGS);

		// Logical payload size, before SQLite's own overhead. This is what
		// #6's "~400 bytes per row" estimate should be compared against.
		const logicalBytes = printings.reduce((n, p) => n
			+ p.id.length + p.gameSystem.length + p.name.length + p.setCode.length
			+ p.setName.length + p.collectorNumber.length + p.rarity.length
			+ p.finish.length + p.language.length + (p.colourIdentity?.length ?? 0)
			+ p.typeLine.length + (p.subtype?.length ?? 0) + p.imageUri.length + 16, 0);
		console.log(`[size]  logical payload = ${(logicalBytes / 1e6).toFixed(1)} MB, ${(logicalBytes / printings.length).toFixed(0)} bytes/row (text + 16 for the numerics)`);

		await DB.exec(BASE_SCHEMA);
		const emptyBytes = await databaseBytes();
		console.log(`[size]  empty database = ${emptyBytes} bytes`);

		// ---------------------------------------------------------------
		// Bulk load (secondary item: import limits and duration)
		// ---------------------------------------------------------------
		const printingStatements = packStatements(
			PRINTING_INSERT_PREFIX,
			printings.map(printingValues),
			MAX_STATEMENT_BYTES,
		);
		const rowsPerStatement = printings.length / printingStatements.length;
		const biggest = Math.max(...printingStatements.map(s => s.length));
		console.log(`[load]  ${printingStatements.length} INSERT statements, ~${rowsPerStatement.toFixed(0)} rows each, largest ${biggest} bytes`);
		expect(biggest).toBeLessThan(100_000);

		const load = await runBatches(printingStatements, 'catalogue_printing');
		console.log(`[load]  catalogue throughput = ${(printings.length / (load.ms / 1000)).toFixed(0)} rows/s`);

		const stockStatements = packStatements(
			'INSERT INTO stock (store_id,printing_id,condition,quantity,sell_price,buy_price) VALUES ',
			stock.map(s => `(${[lit(s.storeId), lit(s.printingId), lit(s.condition), s.quantity, s.sellPrice, s.buyPrice].join(',')})`),
			MAX_STATEMENT_BYTES,
		);
		await runBatches(stockStatements, 'stock');

		const afterDataBytes = await databaseBytes();
		console.log(`[size]  after data, before indexes = ${(afterDataBytes / 1e6).toFixed(1)} MB`);
		console.log(`[size]  → ${((afterDataBytes - emptyBytes) / (printings.length + stock.length)).toFixed(0)} stored bytes per row, unindexed`);

		// Control: confirm rows_read is real in this harness before trusting it anywhere else.
		const control = await measure('CONTROL full scan (unindexed LIKE)', FULL_SCAN_CONTROL, [], 3);
		expect(control.rowsRead).toBeGreaterThanOrEqual(printings.length);

		// ---------------------------------------------------------------
		// The same queries with no indexes at all
		// ---------------------------------------------------------------
		console.log('\n=== unindexed ===');
		await measure('faceted browse (no index)', FACETED_BROWSE, ['magic', 'common', 'U'], 3);
		await measure('faceted in-stock (no index)', FACETED_IN_STOCK, [STORE_ID, 'magic', 'common', 'U'], 3);

		// ---------------------------------------------------------------
		// Indexes
		// ---------------------------------------------------------------
		const tIdx = performance.now();
		for (const sql of INDEXES) {
			const t = performance.now();
			const res = await DB.prepare(sql).run();
			console.log(`[index] ${sql.slice(0, 60)}… ${(performance.now() - t).toFixed(0)}ms rows_written=${(res.meta as { rows_written?: number }).rows_written}`);
		}
		console.log(`[index] all indexes in ${((performance.now() - tIdx) / 1000).toFixed(1)}s`);
		await DB.prepare('PRAGMA optimize').run();

		const afterIndexBytes = await databaseBytes();
		console.log(`[size]  after indexes = ${(afterIndexBytes / 1e6).toFixed(1)} MB (indexes cost ${((afterIndexBytes - afterDataBytes) / 1e6).toFixed(1)} MB)`);
		console.log(`[size]  → ${((afterIndexBytes - emptyBytes) / (printings.length + stock.length)).toFixed(0)} stored bytes per row, indexed`);

		// ---------------------------------------------------------------
		// Indexed faceted queries — the load-bearing measurements
		// ---------------------------------------------------------------
		console.log('\n=== indexed ===');
		await plan('faceted browse', FACETED_BROWSE, ['magic', 'common', 'U']);
		await measure('faceted browse', FACETED_BROWSE, ['magic', 'common', 'U']);

		await plan('faceted browse, page 250', FACETED_BROWSE_DEEP, ['magic', 'common', 'U']);
		await measure('faceted browse, page 250', FACETED_BROWSE_DEEP, ['magic', 'common', 'U']);

		await plan('facet count', FACET_COUNT, ['magic', 'common', 'U']);
		await measure('facet count', FACET_COUNT, ['magic', 'common', 'U']);
		const facetSize = await DB.prepare(FACET_COUNT).bind('magic', 'common', 'U').first<{ n: number }>();
		console.log(`[facet] magic/common/U contains ${facetSize?.n} printings`);

		await plan('faceted browse, multi-select facets', FACETED_BROWSE_MULTI, ['magic']);
		await measure('faceted browse, multi-select facets', FACETED_BROWSE_MULTI, ['magic']);

		await plan('faceted in-stock, price sort', FACETED_IN_STOCK, [STORE_ID, 'magic', 'common', 'U']);
		await measure('faceted in-stock, price sort', FACETED_IN_STOCK, [STORE_ID, 'magic', 'common', 'U']);

		await plan('facet count, in-stock', FACET_COUNT_IN_STOCK, [STORE_ID, 'magic', 'common', 'U']);
		await measure('facet count, in-stock', FACET_COUNT_IN_STOCK, [STORE_ID, 'magic', 'common', 'U']);

		// A rare-card facet, where the mirror-side selectivity is much higher.
		await measure('faceted in-stock, rare+mythic slice', FACETED_IN_STOCK, [STORE_ID, 'magic', 'mythic', 'U']);
		// A non-Magic game, where colour_identity is NULL for every row.
		await measure('faceted browse, pokemon', FACETED_BROWSE.replace('colour_identity = ?3', 'colour_identity IS NULL AND ?3 IS NULL'), ['pokemon', 'rare', null]);

		// ---------------------------------------------------------------
		// Available-to-promise in the same query (#6 says stock is exact)
		// ---------------------------------------------------------------
		await DB.exec([
			'DROP TABLE IF EXISTS hold;',
			'CREATE TABLE hold (id INTEGER PRIMARY KEY AUTOINCREMENT, stock_id INTEGER NOT NULL, basket_id TEXT NOT NULL, quantity INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;',
			'CREATE INDEX hold_stock_expiry ON hold (stock_id, expires_at);',
		].join('\n'));
		const now = 1_800_000_000_000;
		const holdRows = Array.from({ length: 300 }, (_, i) => `(${1 + i * 7},'basket-${i}',1,${now + 60_000})`);
		await DB.prepare(`INSERT INTO hold (stock_id, basket_id, quantity, expires_at) VALUES ${holdRows.join(',')}`).run();
		await plan('faceted in-stock with ATP', FACETED_IN_STOCK_ATP, [STORE_ID, 'magic', 'common', 'U', now]);
		await measure('faceted in-stock with ATP', FACETED_IN_STOCK_ATP, [STORE_ID, 'magic', 'common', 'U', now]);

		// ---------------------------------------------------------------
		// Partial and covering indexes (secondary item)
		// ---------------------------------------------------------------
		console.log('\n=== partial and covering indexes ===');
		const tPartial = performance.now();
		await DB.prepare(PARTIAL_INDEX).run();
		console.log(`[index] partial index built in ${(performance.now() - tPartial).toFixed(0)}ms`);
		await DB.prepare('PRAGMA optimize').run();
		await plan('faceted browse, partial index available', FACETED_BROWSE, ['magic', 'common', 'U']);
		await plan(
			'literal game_system, partial index available',
			FACETED_BROWSE.replace('game_system = ?1', 'game_system = \'magic\'').replace('?2', '?1').replace('?3', '?2'),
			['common', 'U'],
		);
		await measure(
			'literal game_system, partial index available',
			FACETED_BROWSE.replace('game_system = ?1', 'game_system = \'magic\'').replace('?2', '?1').replace('?3', '?2'),
			['common', 'U'],
		);

		await DB.prepare(COVERING_INDEX).run();
		await DB.prepare('PRAGMA optimize').run();
		await plan('faceted browse, covering index available', FACETED_BROWSE, ['magic', 'common', 'U']);
		await measure('faceted browse, covering index available', FACETED_BROWSE, ['magic', 'common', 'U']);

		// ---------------------------------------------------------------
		// Denormalised alternative: facets copied onto the store-owned table
		// ---------------------------------------------------------------
		console.log('\n=== denormalised stock ===');
		await DB.exec(DENORM);
		await DB.prepare(
			'INSERT INTO stock_denorm (id, store_id, printing_id, condition, quantity, sell_price, game_system, rarity, colour_identity) '
			+ 'SELECT s.id, s.store_id, s.printing_id, s.condition, s.quantity, s.sell_price, p.game_system, p.rarity, p.colour_identity '
			+ 'FROM stock s JOIN catalogue_printing p ON p.id = s.printing_id',
		).run();
		await DB.prepare(DENORM_INDEX).run();
		await DB.prepare('PRAGMA optimize').run();
		await plan('faceted in-stock, denormalised', FACETED_DENORM, [STORE_ID, 'magic', 'common', 'U']);
		await measure('faceted in-stock, denormalised', FACETED_DENORM, [STORE_ID, 'magic', 'common', 'U']);

		// ---------------------------------------------------------------
		// Name search (ticket #13 claim 1, at scale)
		// ---------------------------------------------------------------
		console.log('\n=== name search ===');
		await plan('LIKE prefix', NAME_LIKE_PREFIX, ['magic', 'Thundering Sent%']);
		await measure('LIKE prefix', NAME_LIKE_PREFIX, ['magic', 'Thundering Sent%']);
		await plan('LIKE substring (leading wildcard)', NAME_LIKE_SUBSTRING, ['magic', '%Sentinel%']);
		await measure('LIKE substring (leading wildcard)', NAME_LIKE_SUBSTRING, ['magic', '%Sentinel%'], 3);

		// The prefix LIKE did not use `cp_name`. SQLite's LIKE optimisation needs the
		// index collation to match LIKE's case-folding, so a BINARY index cannot serve
		// the default case-insensitive LIKE. Two documented escapes, both tested.
		await DB.prepare('CREATE INDEX cp_name_nocase ON catalogue_printing (game_system, name COLLATE NOCASE)').run();
		await DB.prepare('PRAGMA optimize').run();
		await plan('LIKE prefix, NOCASE index', NAME_LIKE_PREFIX, ['magic', 'Thundering Sent%']);
		await measure('LIKE prefix, NOCASE index', NAME_LIKE_PREFIX, ['magic', 'Thundering Sent%']);

		// `PRAGMA case_sensitive_like` is documented as supported, but D1 also
		// documents that a PRAGMA "only applies to the current transaction" — so
		// whether it can be relied on across statements is itself worth recording.
		const pragmaBatch = await DB.batch([
			DB.prepare('PRAGMA case_sensitive_like = on'),
			DB.prepare(`EXPLAIN QUERY PLAN ${NAME_LIKE_PREFIX}`).bind('magic', 'Thundering Sent%'),
		]);
		console.log('[plan]  LIKE prefix with case_sensitive_like=on, in the same batch');
		for (const row of (pragmaBatch[1]!.results as Array<{ detail: string }>)) console.log(`          ${row.detail}`);

		// External-content FTS5 over the mirror.
		const tFts = performance.now();
		await DB.exec('DROP TABLE IF EXISTS catalogue_fts;');
		await DB.prepare(
			'CREATE VIRTUAL TABLE catalogue_fts USING fts5(name, set_name, type_line, content=\'catalogue_printing\', content_rowid=\'rowid\')',
		).run();
		const ftsBuild = await DB.prepare(
			'INSERT INTO catalogue_fts (rowid, name, set_name, type_line) SELECT rowid, name, set_name, type_line FROM catalogue_printing',
		).run();
		console.log(`[fts5]  built over ${printings.length} rows in ${((performance.now() - tFts) / 1000).toFixed(1)}s, rows_written=${(ftsBuild.meta as { rows_written?: number }).rows_written}`);
		const afterFtsBytes = await databaseBytes();
		console.log(`[size]  after FTS5 index = ${(afterFtsBytes / 1e6).toFixed(1)} MB (FTS5 cost ${((afterFtsBytes - afterIndexBytes) / 1e6).toFixed(1)} MB)`);

		await plan('FTS5 single token', NAME_FTS, ['sentinel']);
		await measure('FTS5 single token', NAME_FTS, ['sentinel']);
		await measure('FTS5 two tokens', NAME_FTS, ['thundering sentinel']);
		await measure('FTS5 prefix token', NAME_FTS, ['sent*']);
		await measure('FTS5 phrase', NAME_FTS, ['"sentinel of storms"']);
		await plan('FTS5 + facets + stock', NAME_FTS_FACETED_IN_STOCK, ['sentinel', STORE_ID, 'magic']);
		await measure('FTS5 + facets + stock', NAME_FTS_FACETED_IN_STOCK, ['sentinel', STORE_ID, 'magic']);

		// Trigram FTS5, for the substring search a staff member typing mid-name wants.
		const tTri = performance.now();
		await DB.exec('DROP TABLE IF EXISTS catalogue_trigram;');
		await DB.prepare('CREATE VIRTUAL TABLE catalogue_trigram USING fts5(name, tokenize=\'trigram\')').run();
		await DB.prepare('INSERT INTO catalogue_trigram (rowid, name) SELECT rowid, name FROM catalogue_printing').run();
		console.log(`[fts5]  trigram index built in ${((performance.now() - tTri) / 1000).toFixed(1)}s`);
		const afterTrigramBytes = await databaseBytes();
		console.log(`[size]  after trigram index = ${(afterTrigramBytes / 1e6).toFixed(1)} MB (trigram cost ${((afterTrigramBytes - afterFtsBytes) / 1e6).toFixed(1)} MB)`);
		await plan('trigram LIKE substring', 'SELECT rowid, name FROM catalogue_trigram WHERE name LIKE ?1 LIMIT 20', ['%entine%']);
		await measure('trigram LIKE substring', 'SELECT rowid, name FROM catalogue_trigram WHERE name LIKE ?1 LIMIT 20', ['%entine%']);
		await measure('trigram MATCH substring', 'SELECT rowid, name FROM catalogue_trigram WHERE catalogue_trigram MATCH ?1 LIMIT 20', ['entine']);

		// ---------------------------------------------------------------
		// What the in-stock query actually scales with
		//
		// The price-sorted query drives from `stock`, so its cost tracks the
		// number of SKUs the store holds, not the size of the mirror. A second,
		// much larger store in the same table makes that visible.
		// ---------------------------------------------------------------
		console.log('\n=== stock-size sensitivity ===');
		const bigStore = 'store-002';
		const bigStock = generateStock(printings, 60_000, bigStore);
		const bigStatements = packStatements(
			'INSERT INTO stock (store_id,printing_id,condition,quantity,sell_price,buy_price) VALUES ',
			bigStock.map(s => `(${[lit(s.storeId), lit(s.printingId), lit(s.condition), s.quantity, s.sellPrice, s.buyPrice].join(',')})`),
			MAX_STATEMENT_BYTES,
		);
		await runBatches(bigStatements, 'stock (60k SKUs, second store)');
		await DB.prepare('PRAGMA optimize').run();
		await plan('faceted in-stock, 60k-SKU store', FACETED_IN_STOCK, [bigStore, 'magic', 'common', 'U']);
		await measure('faceted in-stock, 60k-SKU store', FACETED_IN_STOCK, [bigStore, 'magic', 'common', 'U']);
		await measure('faceted in-stock, 4k-SKU store (repeat)', FACETED_IN_STOCK, [STORE_ID, 'magic', 'common', 'U']);
		// The worst case is not a big store, it is a selective facet: the price-ordered
		// scan cannot stop early when there is nothing to find, so it reads the store out.
		await measure('faceted in-stock, 60k store, empty facet', FACETED_IN_STOCK, [bigStore, 'lorcana', 'mythic', 'WUBRG']);
		await measure('faceted in-stock, 4k store, empty facet', FACETED_IN_STOCK, [STORE_ID, 'lorcana', 'mythic', 'WUBRG']);
		await DB.prepare('CREATE INDEX sd_facet2 ON stock_denorm (store_id, game_system, rarity, colour_identity, sell_price)').run().catch(() => {});
		await measure('same empty facet, denormalised', FACETED_DENORM, [STORE_ID, 'lorcana', 'mythic', 'WUBRG']);

		// ---------------------------------------------------------------
		// Write amplification: what a re-seed or a delta costs in billed rows
		// ---------------------------------------------------------------
		console.log('\n=== write amplification ===');
		const extra = generatePrintings().slice(0, 5_000).map((p, i) => ({ ...p, id: `reseed-${i}-${p.id}` }));
		const extraStatements = packStatements(PRINTING_INSERT_PREFIX, extra.map(printingValues), MAX_STATEMENT_BYTES);
		const reseed = await runBatches(extraStatements, '5,000 rows into the fully-indexed table');
		console.log(`[write] ${(reseed.rowsWritten / extra.length).toFixed(1)} billed rows_written per catalogue row, with every index in place`);
		console.log(`[write] → a full 150k re-seed = ~${((reseed.rowsWritten / extra.length) * 150_000 / 1e6).toFixed(2)}M rows_written`);

		// ---------------------------------------------------------------
		// Incremental sync cost: what a delta pull writes
		// ---------------------------------------------------------------
		console.log('\n=== delta sync ===');
		const deltaIds = printings.slice(0, 2_000).map(p => p.id);
		const tDelta = performance.now();
		let deltaWritten = 0;
		for (let i = 0; i < deltaIds.length; i += 50) {
			const chunk = deltaIds.slice(i, i + 50);
			const res = await DB.prepare(
				`UPDATE catalogue_printing SET market_price = market_price + 1 WHERE id IN (${chunk.map(id => lit(id)).join(',')})`,
			).run();
			deltaWritten += (res.meta as { rows_written?: number }).rows_written ?? 0;
		}
		console.log(`[delta] 2,000 market-price updates in ${(performance.now() - tDelta).toFixed(0)}ms, rows_written=${deltaWritten} (${(deltaWritten / 2000).toFixed(1)} per row — index maintenance included)`);

		// An external-content FTS5 index does NOT follow its base table. Demonstrate
		// the staleness directly, because it is a requirement on the sync module.
		const renameTarget = printings[0]!;
		await DB.prepare('UPDATE catalogue_printing SET name = ?1 WHERE id = ?2')
			.bind('Quicksilver Palimpsest', renameTarget.id).run();
		const staleHit = await DB.prepare(
			'SELECT p.name FROM catalogue_fts f JOIN catalogue_printing p ON p.rowid = f.rowid WHERE catalogue_fts MATCH ?1',
		).bind('palimpsest').first<{ name: string }>();
		const oldTermStillMatches = await DB.prepare(
			'SELECT COUNT(*) AS n FROM catalogue_fts f JOIN catalogue_printing p ON p.rowid = f.rowid WHERE catalogue_fts MATCH ?1 AND p.id = ?2',
		).bind(`"${renameTarget.name}"`, renameTarget.id).first<{ n: number }>();
		console.log(`[delta] after renaming a row in the base table: new term matches = ${staleHit ? 'yes' : 'NO (index is stale)'}; old term still matches = ${oldTermStillMatches?.n}`);
		expect(staleHit).toBeNull();

		// The documented repair: delete the old terms, then reinsert.
		const target = await DB.prepare('SELECT rowid AS rid FROM catalogue_printing WHERE id = ?1')
			.bind(renameTarget.id).first<{ rid: number }>();
		const tFtsDelta = performance.now();
		const del = await DB.prepare(
			'INSERT INTO catalogue_fts (catalogue_fts, rowid, name, set_name, type_line) VALUES (\'delete\', ?1, ?2, ?3, ?4)',
		).bind(target!.rid, renameTarget.name, renameTarget.setName, renameTarget.typeLine).run();
		const ins = await DB.prepare(
			'INSERT INTO catalogue_fts (rowid, name, set_name, type_line) SELECT rowid, name, set_name, type_line FROM catalogue_printing WHERE id = ?1',
		).bind(renameTarget.id).run();
		console.log(`[delta] FTS5 repair: delete rows_written=${(del.meta as { rows_written?: number }).rows_written}, reinsert rows_written=${(ins.meta as { rows_written?: number }).rows_written}, ${(performance.now() - tFtsDelta).toFixed(0)}ms`);
		const repaired = await DB.prepare(
			'SELECT p.name FROM catalogue_fts f JOIN catalogue_printing p ON p.rowid = f.rowid WHERE catalogue_fts MATCH ?1',
		).bind('palimpsest').first<{ name: string }>();
		console.log(`[delta] after repair, new term matches = ${repaired?.name ?? 'still not found'}`);

		// ---------------------------------------------------------------
		// How representative is this corpus? An FTS5 index's size is driven by
		// distinct terms, and a generated corpus has far fewer than a real one.
		// ---------------------------------------------------------------
		console.log('\n=== corpus diversity (read this before trusting the size figures) ===');
		const distinct = await DB.prepare(
			'SELECT COUNT(DISTINCT name) AS names, COUNT(DISTINCT set_name) AS sets FROM catalogue_printing',
		).first<{ names: number; sets: number }>();
		await DB.exec('DROP TABLE IF EXISTS catalogue_fts_vocab;');
		await DB.prepare('CREATE VIRTUAL TABLE catalogue_fts_vocab USING fts5vocab(catalogue_fts, \'row\')').run();
		const terms = await DB.prepare('SELECT COUNT(*) AS n, SUM(cnt) AS instances FROM catalogue_fts_vocab').first<{ n: number; instances: number }>();
		console.log(`[corpus] ${distinct?.names} distinct names and ${distinct?.sets} distinct set names across ${printings.length} printings`);
		console.log(`[corpus] FTS5 index holds ${terms?.n} distinct terms over ${terms?.instances} instances`);

		// ---------------------------------------------------------------
		// Summary
		// ---------------------------------------------------------------
		console.log('\n=== summary (median ms / rows_read) ===');
		for (const m of measurements) {
			console.log(`  ${m.label.padEnd(44)} ${m.medianMs.toFixed(2).padStart(9)}ms  ${String(m.rowsRead).padStart(9)} rows_read`);
		}
		const finalBytes = await databaseBytes();
		console.log(`\n[size]  final database = ${(finalBytes / 1e6).toFixed(1)} MB for ${printings.length} printings + ${stock.length} stock rows`);
		console.log(`[size]  against D1's 10 GB ceiling: ${((finalBytes / 10e9) * 100).toFixed(2)}%`);
	});
});
