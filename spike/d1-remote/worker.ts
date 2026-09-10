/**
 * Throwaway spike (issue #17): re-run the D1 spikes against a REAL D1 database.
 *
 * A deployed Worker that exposes every measurement as an HTTP endpoint, so the
 * numbers are taken where they matter — Worker → remote D1 — not in-process
 * SQLite under miniflare. `drive.mjs` calls these in order and records JSON.
 *
 * Reuses the spike modules verbatim: the hold statement from #4, the corpus,
 * schema and queries from #13, the fold rule and per-token trigram shape from #24.
 */
import { RESERVE_SQL, reserve, reserveStatement } from '../d1-hold-atomicity/reserve';
import { SCHEMA as HOLD_SCHEMA } from '../d1-hold-atomicity/schema';
import * as Q from '../d1-search/queries';
import { BASE_SCHEMA, COVERING_INDEX, DENORM, DENORM_INDEX, INDEXES } from '../d1-search/schema';
import {
	PRINTING_INSERT_PREFIX,
	generatePrintings,
	generateStock,
	lit,
	packStatements,
	printingValues,
	type Printing,
} from '../d1-search/seed';
import realNames from '../typo-search/data/all-card-names.json';

export interface Env {
	DB: D1Database;
	SPIKE_TOKEN: string;
}

interface Meta {
	duration?: number;
	rows_read?: number;
	rows_written?: number;
	size_after?: number;
	changes?: number;
}

const TTL_MS = 60_000;
const STORE_A = 'store-001';
const STORE_B = 'store-002';

let printingsCache: Printing[] | null = null;
function printings(): Printing[] {
	printingsCache ??= generatePrintings();
	return printingsCache;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function num(url: URL, key: string, fallback: number): number {
	const v = url.searchParams.get(key);
	return v === null ? fallback : Number(v);
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}
function p95(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length * 0.95)] ?? s[s.length - 1] ?? 0;
}
function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
const r2 = (n: number) => Math.round(n * 100) / 100;

async function sizeAfter(db: D1Database): Promise<number> {
	const r = await db.prepare('SELECT 1').all();
	return (r.meta as Meta).size_after ?? -1;
}

/** Worker-observed wall-clock (includes the hop to D1) and D1's own `meta.duration`, both per run. */
async function measure(db: D1Database, label: string, sql: string, binds: unknown[] = [], runs = 7) {
	const wall: number[] = [];
	const d1: number[] = [];
	let rowsRead = 0;
	let returned = 0;
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		const r = await db.prepare(sql).bind(...binds).all();
		wall.push(performance.now() - t);
		d1.push((r.meta as Meta).duration ?? 0);
		rowsRead = (r.meta as Meta).rows_read ?? 0;
		returned = r.results.length;
	}
	return {
		label,
		runs,
		wallMedianMs: r2(median(wall)),
		wallMinMs: r2(Math.min(...wall)),
		wallMaxMs: r2(Math.max(...wall)),
		d1DurationMedianMs: r2(median(d1)),
		rowsRead,
		returned,
	};
}

async function plan(db: D1Database, sql: string, binds: unknown[] = []): Promise<string[]> {
	const r = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
	return r.results.map(x => x.detail);
}

/** Run packed statements in batches of `perBatch`, recording each batch. */
async function runBatches(db: D1Database, statements: string[], perBatch: number) {
	const batches: Array<{ statements: number; ms: number; rowsWritten: number; d1DurationMs: number }> = [];
	let rowsWritten = 0;
	const t0 = performance.now();
	for (let i = 0; i < statements.length; i += perBatch) {
		const chunk = statements.slice(i, i + perBatch).map(s => db.prepare(s));
		const t = performance.now();
		const results = await db.batch(chunk);
		const ms = performance.now() - t;
		let rw = 0;
		let dur = 0;
		for (const r of results) {
			rw += (r.meta as Meta).rows_written ?? 0;
			dur += (r.meta as Meta).duration ?? 0;
		}
		rowsWritten += rw;
		batches.push({ statements: chunk.length, ms: r2(ms), rowsWritten: rw, d1DurationMs: r2(dur) });
	}
	return { totalMs: r2(performance.now() - t0), rowsWritten, batches };
}

function packStats(statements: string[], rows: number) {
	const sizes = statements.map(s => s.length);
	return {
		rows,
		statements: statements.length,
		rowsPerStatement: r2(rows / Math.max(1, statements.length)),
		largestStatementBytes: Math.max(...sizes),
		meanStatementBytes: Math.round(mean(sizes)),
	};
}

// ---------------------------------------------------------------------------
// #4 — hold atomicity
// ---------------------------------------------------------------------------

async function holdReset(db: D1Database, onHand: number) {
	await db.exec(HOLD_SCHEMA);
	await db.prepare('INSERT INTO inventory_item (id, on_hand) VALUES (?1, ?2)').bind('sku-1', onHand).run();
}
async function holdRows(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COUNT(*) AS n FROM hold WHERE inventory_item_id = ?1').bind('sku-1').first<{ n: number }>();
	return row?.n ?? 0;
}
async function heldQty(db: D1Database): Promise<number> {
	const row = await db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM hold WHERE inventory_item_id = ?1').bind('sku-1').first<{ q: number }>();
	return row?.q ?? 0;
}

async function holdStampede(db: D1Database, url: URL) {
	const concurrency = num(url, 'concurrency', 25);
	const iterations = num(url, 'iterations', 5);
	const qty = num(url, 'qty', 1);
	const onHand = num(url, 'onHand', 1);
	const mode = url.searchParams.get('mode') ?? 'direct'; // direct | batch
	const expected = Math.floor(onHand / qty);

	const successCounts: number[] = [];
	const oversells: Array<{ iteration: number; rows: number; granted: number }> = [];
	const iterationMs: number[] = [];
	const perStatementMs: number[] = [];

	for (let iteration = 0; iteration < iterations; iteration++) {
		await db.prepare('DELETE FROM hold').run();
		const now = Date.now();
		const t = performance.now();
		const attempts = Array.from({ length: concurrency }, (_, i) => {
			const input = { itemId: 'sku-1', basketId: `basket-${i}`, quantity: qty, expiresAt: now + TTL_MS, now };
			const ts = performance.now();
			const p = mode === 'batch'
				? db.batch([reserveStatement(db, input), db.prepare('SELECT changes() AS c')]).then(b => (b[0]!.meta as Meta).changes ?? 0)
				: reserve(db, input).then(r => r.changes);
			return p.then((changes) => {
				perStatementMs.push(performance.now() - ts);
				return changes;
			});
		});
		const changes = await Promise.all(attempts);
		iterationMs.push(performance.now() - t);
		const granted = changes.filter(c => c > 0).length;
		const rows = await holdRows(db);
		successCounts.push(granted);
		if (granted !== expected || rows !== expected) oversells.push({ iteration, rows, granted });
	}
	return {
		mode,
		concurrency,
		iterations,
		qty,
		onHand,
		expectedGrants: expected,
		distinctSuccesses: [...new Set(successCounts)].sort((a, b) => a - b),
		oversellIterations: oversells.length,
		oversells,
		iterationMs: { median: r2(median(iterationMs)), max: r2(Math.max(...iterationMs)) },
		statementMs: { median: r2(median(perStatementMs)), p95: r2(p95(perStatementMs)), max: r2(Math.max(...perStatementMs)) },
	};
}

/** Negative control: the naive JS read-then-write, which MUST oversell for the harness to mean anything. */
async function holdNaive(db: D1Database, url: URL) {
	const concurrency = num(url, 'concurrency', 25);
	const iterations = num(url, 'iterations', 5);
	async function naive(basketId: string, now: number): Promise<boolean> {
		const row = await db.prepare(
			'SELECT (SELECT on_hand FROM inventory_item WHERE id = ?1) '
			+ '- COALESCE((SELECT SUM(quantity) FROM hold WHERE inventory_item_id = ?1 AND expires_at > ?2), 0) AS available',
		).bind('sku-1', now).first<{ available: number }>();
		if ((row?.available ?? 0) < 1) return false;
		await db.prepare('INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?1, ?2, ?3, ?4)')
			.bind('sku-1', basketId, 1, now + TTL_MS).run();
		return true;
	}
	const successCounts: number[] = [];
	let oversellIterations = 0;
	for (let iteration = 0; iteration < iterations; iteration++) {
		await db.prepare('DELETE FROM hold').run();
		const now = Date.now();
		const results = await Promise.all(Array.from({ length: concurrency }, (_, i) => naive(`basket-${i}`, now)));
		const granted = results.filter(Boolean).length;
		successCounts.push(granted);
		if (granted > 1) oversellIterations++;
	}
	return { concurrency, iterations, distinctSuccesses: [...new Set(successCounts)].sort((a, b) => a - b), oversellIterations };
}

async function holdMixed(db: D1Database, url: URL) {
	const iterations = num(url, 'iterations', 10);
	const sizes = [1, 2, 3, 1, 4, 2, 5, 1, 3, 2];
	const heldTotals: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		await db.prepare('DELETE FROM hold').run();
		const now = Date.now();
		await Promise.all(sizes.map((quantity, i) => reserve(db, { itemId: 'sku-1', basketId: `basket-${i}`, quantity, expiresAt: now + TTL_MS, now })));
		heldTotals.push(await heldQty(db));
	}
	return { onHand: 7, iterations, distinctHeldTotals: [...new Set(heldTotals)].sort((a, b) => a - b), overCommits: heldTotals.filter(h => h > 7).length };
}

/** The batch conditionality cases from measurement 4, on real D1. */
async function holdBatchCases(db: D1Database) {
	const out: Record<string, unknown> = {};
	const now = Date.now();
	const input = (basketId: string) => ({ itemId: 'sku-1', basketId, quantity: 1, expiresAt: now + TTL_MS, now });

	await holdReset(db, 1);
	const pair = await db.batch([reserveStatement(db, input('b1')), reserveStatement(db, input('b2'))]);
	out.sameItemPairChanges = pair.map(r => (r.meta as Meta).changes);
	out.sameItemPairRows = await holdRows(db);

	await holdReset(db, 1);
	await reserve(db, input('b1'));
	const unconditional = await db.batch([
		reserveStatement(db, input('b2')),
		db.prepare('UPDATE inventory_item SET on_hand = on_hand - 1 WHERE id = ?1').bind('sku-1'),
	]);
	const afterUncond = await db.prepare('SELECT on_hand FROM inventory_item WHERE id = ?1').bind('sku-1').first<{ on_hand: number }>();
	out.unconditionalFollowOn = { holdChanges: (unconditional[0]!.meta as Meta).changes, onHandAfter: afterUncond?.on_hand };

	await holdReset(db, 1);
	await reserve(db, input('b1'));
	const gated = await db.batch([
		reserveStatement(db, input('b2')),
		db.prepare('UPDATE inventory_item SET on_hand = on_hand - 1 WHERE id = ?1 AND EXISTS (SELECT 1 FROM hold WHERE basket_id = ?2 AND inventory_item_id = ?1)').bind('sku-1', 'b2'),
	]);
	const afterGated = await db.prepare('SELECT on_hand FROM inventory_item WHERE id = ?1').bind('sku-1').first<{ on_hand: number }>();
	out.gatedFollowOn = { holdChanges: (gated[0]!.meta as Meta).changes, followOnChanges: (gated[1]!.meta as Meta).changes, onHandAfter: afterGated?.on_hand };

	await holdReset(db, 1);
	let rolledBack = false;
	try {
		await db.batch([reserveStatement(db, input('b1')), db.prepare('INSERT INTO no_such_table (x) VALUES (1)')]);
	}
	catch {
		rolledBack = (await holdRows(db)) === 0;
	}
	out.failingBatchRolledBack = rolledBack;

	await holdReset(db, 1);
	await db.prepare('INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?1, ?2, ?3, ?4)').bind('sku-1', 'stale', 1, now - 1).run();
	out.expiredHoldIgnored = (await reserve(db, input('fresh'))).granted;

	await holdReset(db, 1);
	const single = await measure(db, 'single reserve statement, warm', RESERVE_SQL, ['sku-1', 'bench', 0, now + TTL_MS, now], 9);
	out.reserveStatementLatency = single;
	return out;
}

// ---------------------------------------------------------------------------
// #13 / #14 — catalogue mirror at scale
// ---------------------------------------------------------------------------

const SEARCH_HOLD = [
	'DROP TABLE IF EXISTS hold;',
	'CREATE TABLE hold (id INTEGER PRIMARY KEY AUTOINCREMENT, stock_id INTEGER NOT NULL, quantity INTEGER NOT NULL, expires_at INTEGER NOT NULL);',
	'CREATE INDEX hold_stock ON hold (stock_id, expires_at);',
].join('\n');

const DETAIL_SCHEMA = [
	'DROP TABLE IF EXISTS printing_detail;',
	'CREATE TABLE printing_detail (printing_id TEXT PRIMARY KEY, detail TEXT NOT NULL) STRICT;',
].join('\n');

/** A stand-in for a full Catalogue export record: the Printing plus the kind of fields an export carries. Size is reported, not assumed. */
function detailJson(p: Printing): string {
	return JSON.stringify({
		id: p.id,
		gameSystem: p.gameSystem,
		name: p.name,
		set: { code: p.setCode, name: p.setName, releasedAt: p.releasedAt },
		collectorNumber: p.collectorNumber,
		rarity: p.rarity,
		finish: p.finish,
		language: p.language,
		colourIdentity: p.colourIdentity,
		typeLine: p.typeLine,
		subtype: p.subtype,
		manaValue: p.manaValue,
		marketPrice: p.marketPrice,
		images: { small: p.imageUri, normal: p.imageUri.replace('.jpg', '-normal.jpg'), large: p.imageUri.replace('.jpg', '-large.jpg'), artCrop: p.imageUri.replace('.jpg', '-art.jpg') },
		oracleText: `${p.name} enters the battlefield tapped. When ${p.name} deals combat damage to a player, you may draw a card. ${p.typeLine}. Sacrifice ${p.name}: add one mana of any colour.`,
		flavourText: `"The ${p.subtype ?? 'wastes'} remember what the living forget."`,
		legalities: Object.fromEntries(['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'brawl', 'historic', 'alchemy', 'explorer', 'timeless', 'oathbreaker', 'penny', 'duel', 'premodern', 'oldschool', 'predh'].map(f => [f, 'legal'])),
		artist: 'Example Artist',
		keywords: ['Flying', 'Vigilance'],
		revision: 1,
		updatedAt: p.releasedAt + 1,
	});
}

async function searchSeed(db: D1Database, url: URL) {
	const all = printings();
	const from = num(url, 'from', 0);
	const to = Math.min(num(url, 'to', all.length), all.length);
	const maxBytes = num(url, 'maxBytes', 90_000);
	const perBatch = num(url, 'perBatch', 200);
	const page = all.slice(from, to);
	const statements = packStatements(PRINTING_INSERT_PREFIX, page.map(printingValues), maxBytes);
	const stats = packStats(statements, page.length);
	const load = await runBatches(db, statements, perBatch);
	return { from, to, maxBytes, perBatch, ...stats, ...load, sizeAfter: await sizeAfter(db) };
}

async function searchDetail(db: D1Database, url: URL) {
	const all = printings();
	const from = num(url, 'from', 0);
	const to = Math.min(num(url, 'to', all.length), all.length);
	const maxBytes = num(url, 'maxBytes', 90_000);
	const perBatch = num(url, 'perBatch', 200);
	if (from === 0) await db.exec(DETAIL_SCHEMA);
	const page = all.slice(from, to);
	const values = page.map(p => `(${lit(p.id)},${lit(detailJson(p))})`);
	const bytesPerRecord = Math.round(mean(page.slice(0, 200).map(p => detailJson(p).length)));
	const statements = packStatements('INSERT INTO printing_detail (printing_id, detail) VALUES ', values, maxBytes);
	const stats = packStats(statements, page.length);
	const load = await runBatches(db, statements, perBatch);
	return { from, to, bytesPerRecord, ...stats, ...load, sizeAfter: await sizeAfter(db) };
}

async function searchStock(db: D1Database, url: URL) {
	const store = url.searchParams.get('store') ?? STORE_A;
	const skus = num(url, 'skus', 4_000);
	const perBatch = num(url, 'perBatch', 200);
	const stock = generateStock(printings(), skus, store);
	const statements = packStatements(
		'INSERT INTO stock (store_id,printing_id,condition,quantity,sell_price,buy_price) VALUES ',
		stock.map(s => `(${[lit(s.storeId), lit(s.printingId), lit(s.condition), s.quantity, s.sellPrice, s.buyPrice].join(',')})`),
		90_000,
	);
	const load = await runBatches(db, statements, perBatch);
	return { store, skus, ...packStats(statements, stock.length), ...load, sizeAfter: await sizeAfter(db) };
}

async function searchIndexes(db: D1Database) {
	const before = await sizeAfter(db);
	const out: Array<{ sql: string; ms: number; rowsWritten: number; d1DurationMs: number }> = [];
	for (const sql of [...INDEXES, COVERING_INDEX]) {
		const t = performance.now();
		const r = await db.prepare(sql).run();
		out.push({ sql: sql.slice(0, 70), ms: r2(performance.now() - t), rowsWritten: (r.meta as Meta).rows_written ?? 0, d1DurationMs: r2((r.meta as Meta).duration ?? 0) });
	}
	await db.prepare('PRAGMA optimize').run();
	const after = await sizeAfter(db);
	return { indexes: out, totalMs: r2(out.reduce((a, b) => a + b.ms, 0)), bytesBefore: before, bytesAfter: after };
}

async function searchFts(db: D1Database) {
	const before = await sizeAfter(db);
	await db.exec('DROP TABLE IF EXISTS catalogue_fts;');
	await db.prepare('CREATE VIRTUAL TABLE catalogue_fts USING fts5(name, set_name, type_line, content=\'catalogue_printing\', content_rowid=\'rowid\')').run();
	const t = performance.now();
	const build = await db.prepare('INSERT INTO catalogue_fts (rowid, name, set_name, type_line) SELECT rowid, name, set_name, type_line FROM catalogue_printing').run();
	const ftsMs = performance.now() - t;
	const afterFts = await sizeAfter(db);

	await db.exec('DROP TABLE IF EXISTS catalogue_trigram;');
	await db.prepare('CREATE VIRTUAL TABLE catalogue_trigram USING fts5(name, tokenize=\'trigram\')').run();
	const t2 = performance.now();
	const tri = await db.prepare('INSERT INTO catalogue_trigram (rowid, name) SELECT rowid, name FROM catalogue_printing').run();
	const triMs = performance.now() - t2;
	const afterTri = await sizeAfter(db);
	return {
		fts5: { ms: r2(ftsMs), d1DurationMs: r2((build.meta as Meta).duration ?? 0), rowsWritten: (build.meta as Meta).rows_written, bytes: afterFts - before },
		trigramFts5: { ms: r2(triMs), d1DurationMs: r2((tri.meta as Meta).duration ?? 0), rowsWritten: (tri.meta as Meta).rows_written, bytes: afterTri - afterFts },
	};
}

async function searchDenorm(db: D1Database) {
	await db.exec(DENORM);
	const t = performance.now();
	const r = await db.prepare(
		'INSERT INTO stock_denorm (id, store_id, printing_id, condition, quantity, sell_price, game_system, rarity, colour_identity) '
		+ 'SELECT s.id, s.store_id, s.printing_id, s.condition, s.quantity, s.sell_price, p.game_system, p.rarity, p.colour_identity FROM stock s JOIN catalogue_printing p ON p.id = s.printing_id',
	).run();
	await db.prepare(DENORM_INDEX).run();
	return { ms: r2(performance.now() - t), rowsWritten: (r.meta as Meta).rows_written };
}

async function searchMeasure(db: D1Database) {
	const now = Date.now();
	const results: Array<Awaited<ReturnType<typeof measure>>> = [];
	const plans: Record<string, string[]> = {};
	const m = async (label: string, sql: string, binds: unknown[] = [], runs = 7) => results.push(await measure(db, label, sql, binds, runs));

	await m('round-trip floor: SELECT 1', 'SELECT 1', [], 9);
	await m('point lookup by primary key', 'SELECT id, name FROM catalogue_printing WHERE id = ?1', [printings()[500]!.id], 9);
	await m('CONTROL full scan (unindexed LIKE)', Q.FULL_SCAN_CONTROL, [], 3);

	plans['faceted browse'] = await plan(db, Q.FACETED_BROWSE, ['magic', 'common', 'U']);
	await m('faceted browse (covering index present)', Q.FACETED_BROWSE, ['magic', 'common', 'U']);
	await m('faceted browse, page 250', Q.FACETED_BROWSE_DEEP, ['magic', 'common', 'U']);
	await m('facet count', Q.FACET_COUNT, ['magic', 'common', 'U']);
	await m('faceted browse, multi-select facets', Q.FACETED_BROWSE_MULTI, ['magic']);
	await m('faceted browse, pokemon', Q.FACETED_BROWSE.replace('colour_identity = ?3', 'colour_identity IS NULL AND ?3 IS NULL'), ['pokemon', 'rare', null]);

	plans['faceted in-stock'] = await plan(db, Q.FACETED_IN_STOCK, [STORE_A, 'magic', 'common', 'U']);
	await m('faceted in-stock, price sort, 4k-SKU store', Q.FACETED_IN_STOCK, [STORE_A, 'magic', 'common', 'U']);
	await m('facet count, in-stock', Q.FACET_COUNT_IN_STOCK, [STORE_A, 'magic', 'common', 'U']);
	await m('faceted in-stock, rare+mythic slice', Q.FACETED_IN_STOCK, [STORE_A, 'magic', 'mythic', 'U']);
	await m('faceted in-stock with ATP', Q.FACETED_IN_STOCK_ATP, [STORE_A, 'magic', 'common', 'U', now]);
	await m('faceted in-stock, 60k-SKU store', Q.FACETED_IN_STOCK, [STORE_B, 'magic', 'common', 'U']);
	plans['empty facet 60k'] = await plan(db, Q.FACETED_IN_STOCK, [STORE_B, 'lorcana', 'mythic', 'WUBRG']);
	await m('faceted in-stock, 60k store, EMPTY facet', Q.FACETED_IN_STOCK, [STORE_B, 'lorcana', 'mythic', 'WUBRG']);
	await m('faceted in-stock, 4k store, EMPTY facet', Q.FACETED_IN_STOCK, [STORE_A, 'lorcana', 'mythic', 'WUBRG']);
	await m('same empty facet, denormalised', Q.FACETED_DENORM, [STORE_B, 'lorcana', 'mythic', 'WUBRG']);
	await m('faceted in-stock, denormalised', Q.FACETED_DENORM, [STORE_A, 'magic', 'common', 'U']);

	plans['FTS5 single token'] = await plan(db, Q.NAME_FTS, ['sentinel']);
	await m('FTS5 single token', Q.NAME_FTS, ['sentinel']);
	await m('FTS5 two tokens', Q.NAME_FTS, ['thundering sentinel']);
	await m('FTS5 prefix token', Q.NAME_FTS, ['sent*']);
	await m('FTS5 phrase', Q.NAME_FTS, ['"sentinel of storms"']);
	await m('FTS5 + facets + stock', Q.NAME_FTS_FACETED_IN_STOCK, ['sentinel', STORE_A, 'magic']);
	await m('trigram MATCH substring', 'SELECT rowid, name FROM catalogue_trigram WHERE catalogue_trigram MATCH ?1 LIMIT 20', ['entine']);
	await m('LIKE prefix, bound parameter', Q.NAME_LIKE_PREFIX, ['magic', 'Thundering Sent%'], 3);
	await m('printing_detail by primary key', 'SELECT detail FROM printing_detail WHERE printing_id = ?1', [printings()[500]!.id]);

	const corpus = await db.prepare('SELECT COUNT(*) AS printings, COUNT(DISTINCT name) AS names FROM catalogue_printing').first();
	return { results, plans, corpus, sizeAfter: await sizeAfter(db) };
}

async function searchReseed(db: D1Database) {
	const extra = printings().slice(0, 5_000).map((p, i) => ({ ...p, id: `reseed-${i}-${p.id}` }));
	const statements = packStatements(PRINTING_INSERT_PREFIX, extra.map(printingValues), 90_000);
	const load = await runBatches(db, statements, 200);
	const ids = printings().slice(0, 2_000).map(p => p.id);
	const t = performance.now();
	let deltaWritten = 0;
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const r = await db.prepare(`UPDATE catalogue_printing SET market_price = market_price + 1 WHERE id IN (${chunk.map(id => lit(id)).join(',')})`).run();
		deltaWritten += (r.meta as Meta).rows_written ?? 0;
	}
	return {
		reseed5000: { ...load, rowsWrittenPerRow: r2(load.rowsWritten / extra.length) },
		delta2000: { ms: r2(performance.now() - t), rowsWritten: deltaWritten, rowsWrittenPerRow: r2(deltaWritten / 2000), statements: ids.length / 50 },
	};
}

// ---------------------------------------------------------------------------
// #24 — per-token trigram fallback, real names
// ---------------------------------------------------------------------------

const fold = (s: string) => s
	.normalize('NFKD')
	.replace(/\p{M}/gu, '')
	.toLowerCase()
	.replace(/['’ʼ‘`]/g, '')
	.replace(/[^a-z0-9]+/g, ' ')
	.trim()
	.replace(/\s+/g, ' ');

function trigrams(token: string): string[] {
	const padded = `  ${token}  `;
	const out: string[] = [];
	for (let i = 0; i < token.length + 2; i++) out.push(padded.slice(i, i + 3));
	return out;
}

/** The exact query set from `spike/token-trigram/scaling.mjs`: same LCG, same shuffle, same 400 substituted tokens. */
function tokenCorpus() {
	let seed = 42;
	const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
	const shuffled = (realNames as string[]).slice();
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}
	const vocab = new Set<string>();
	for (const name of shuffled) for (const t of fold(name).split(' ')) if (t) vocab.add(t);
	const allTokens = [...vocab].filter(t => t.length >= 5);
	const queries = Array.from({ length: 400 }, () => {
		const t = allTokens[Math.floor(rnd() * allTokens.length)]!;
		const p = Math.floor(rnd() * t.length);
		return `${t.slice(0, p)}x${t.slice(p + 1)}`;
	});
	const postings = new Map<string, number>();
	for (const token of vocab) for (const g of trigrams(token)) postings.set(g, (postings.get(g) ?? 0) + 1);
	return { vocab, queries, postings };
}

async function trigramBuild(db: D1Database, url: URL) {
	const perBatch = num(url, 'perBatch', 200);
	const { vocab } = tokenCorpus();
	const before = await sizeAfter(db);
	await db.exec([
		'DROP TABLE IF EXISTS token_trigram;',
		'DROP TABLE IF EXISTS card_name;',
		'CREATE TABLE card_name (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_folded TEXT NOT NULL) STRICT;',
		'CREATE TABLE token_trigram (trigram TEXT NOT NULL, token TEXT NOT NULL) STRICT;',
	].join('\n'));
	const nameValues = (realNames as string[]).map((n, i) => `(${i + 1},${lit(n)},${lit(fold(n))})`);
	const nameLoad = await runBatches(db, packStatements('INSERT INTO card_name (id, name, name_folded) VALUES ', nameValues, 90_000), perBatch);
	await db.prepare('CREATE INDEX card_name_folded ON card_name (name_folded)').run();
	const rows: string[] = [];
	for (const token of vocab) for (const g of trigrams(token)) rows.push(`(${lit(g)},${lit(token)})`);
	const statements = packStatements('INSERT INTO token_trigram (trigram, token) VALUES ', rows, 90_000);
	const load = await runBatches(db, statements, perBatch);
	const t = performance.now();
	const idx = await db.prepare('CREATE INDEX token_trigram_covering ON token_trigram (trigram, token)').run();
	const idxMs = performance.now() - t;
	await db.prepare('PRAGMA optimize').run();
	return {
		names: realNames.length,
		tokens: vocab.size,
		tableRows: rows.length,
		nameLoad: { totalMs: nameLoad.totalMs, rowsWritten: nameLoad.rowsWritten },
		...packStats(statements, rows.length),
		load: { totalMs: load.totalMs, rowsWritten: load.rowsWritten, batches: load.batches.length },
		index: { ms: r2(idxMs), rowsWritten: (idx.meta as Meta).rows_written },
		bytes: (await sizeAfter(db)) - before,
	};
}

async function trigramMeasure(db: D1Database, url: URL) {
	const n = num(url, 'n', 100);
	const { queries, postings } = tokenCorpus();
	const sample = queries.slice(0, n);
	const sql = (k: number) => `SELECT token, COUNT(*) AS c FROM token_trigram WHERE trigram IN (${Array.from({ length: k }, (_, i) => `?${i + 1}`).join(',')}) GROUP BY token ORDER BY c DESC LIMIT 10`;

	const predicted: number[] = [];
	const measured: number[] = [];
	const wall: number[] = [];
	const d1: number[] = [];
	const rarestPredicted: number[] = [];
	const rarestMeasured: number[] = [];
	const rarestWall: number[] = [];
	const missWall: number[] = [];
	const missRows: number[] = [];
	let plans: Record<string, string[]> = {};

	for (const [i, q] of sample.entries()) {
		const grams = [...new Set(trigrams(q))];
		predicted.push(grams.reduce((a, g) => a + (postings.get(g) ?? 0), 0));
		if (i === 0) plans = { full: await plan(db, sql(grams.length), grams) };
		const t = performance.now();
		const r = await db.prepare(sql(grams.length)).bind(...grams).all();
		wall.push(performance.now() - t);
		d1.push((r.meta as Meta).duration ?? 0);
		measured.push((r.meta as Meta).rows_read ?? 0);

		const rarest = grams.slice().sort((a, b) => (postings.get(a) ?? 0) - (postings.get(b) ?? 0)).slice(0, 5);
		rarestPredicted.push(rarest.reduce((a, g) => a + (postings.get(g) ?? 0), 0));
		const t2 = performance.now();
		const r2_ = await db.prepare(sql(rarest.length)).bind(...rarest).all();
		rarestWall.push(performance.now() - t2);
		rarestMeasured.push((r2_.meta as Meta).rows_read ?? 0);

		// The cheap path the cascade tries first: an exact folded-column hit. This query is a miss by construction.
		const t3 = performance.now();
		const miss = await db.prepare('SELECT id FROM card_name WHERE name_folded = ?1').bind(q).all();
		missWall.push(performance.now() - t3);
		missRows.push((miss.meta as Meta).rows_read ?? 0);
	}
	const exact = measured.filter((m, i) => m === predicted[i]).length;
	return {
		queries: sample.length,
		plans,
		fullQuery: {
			rowsRead: { predictedMean: Math.round(mean(predicted)), measuredMean: Math.round(mean(measured)), predictedP95: p95(predicted), measuredP95: p95(measured), exactMatches: exact },
			wallMs: { median: r2(median(wall)), p95: r2(p95(wall)), max: r2(Math.max(...wall)) },
			d1DurationMs: { median: r2(median(d1)), p95: r2(p95(d1)) },
		},
		rarest5: {
			rowsRead: { predictedMean: Math.round(mean(rarestPredicted)), measuredMean: Math.round(mean(rarestMeasured)), measuredP95: p95(rarestMeasured) },
			wallMs: { median: r2(median(rarestWall)), p95: r2(p95(rarestWall)) },
		},
		cheapPathMiss: { rowsRead: { max: Math.max(...missRows), mean: r2(mean(missRows)) }, wallMs: { median: r2(median(missWall)), p95: r2(p95(missWall)) } },
	};
}

// ---------------------------------------------------------------------------
// probes for the undocumented limits (#14)
// ---------------------------------------------------------------------------

async function probeBatch(db: D1Database, url: URL) {
	const n = num(url, 'n', 100);
	const t = performance.now();
	try {
		const r = await db.batch(Array.from({ length: n }, () => db.prepare('SELECT 1')));
		return { n, ok: true, results: r.length, ms: r2(performance.now() - t) };
	}
	catch (e) {
		return { n, ok: false, error: String((e as Error).message ?? e), ms: r2(performance.now() - t) };
	}
}

async function probeStatementBytes(db: D1Database, url: URL) {
	const bytes = num(url, 'bytes', 100_000);
	const prefix = 'SELECT length(\'';
	const suffix = '\') AS n';
	const sql = prefix + 'a'.repeat(Math.max(0, bytes - prefix.length - suffix.length)) + suffix;
	try {
		const r = await db.prepare(sql).first<{ n: number }>();
		return { bytes: sql.length, ok: true, n: r?.n };
	}
	catch (e) {
		return { bytes: sql.length, ok: false, error: String((e as Error).message ?? e) };
	}
}

// ---------------------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.headers.get('x-spike-token') !== env.SPIKE_TOKEN) return new Response('forbidden', { status: 403 });
		const db = env.DB;
		const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf;
		try {
			switch (url.pathname) {
				case '/ping': return json({ colo: cf?.colo, country: cf?.country, now: Date.now() });
				case '/size': return json({ sizeAfter: await sizeAfter(db) });

				case '/hold/reset': await holdReset(db, num(url, 'onHand', 1)); return json({ ok: true });
				case '/hold/reserve': {
					const body = (await request.json()) as { itemId: string; basketId: string; quantity: number; now: number };
					const t = performance.now();
					const r = await reserve(db, { itemId: body.itemId, basketId: body.basketId, quantity: body.quantity, expiresAt: body.now + TTL_MS, now: body.now });
					return json({ ...r, ms: r2(performance.now() - t), colo: cf?.colo });
				}
				case '/hold/truncate': await db.prepare('DELETE FROM hold').run(); return json({ ok: true });
				case '/hold/count': return json({ rows: await holdRows(db) });
				case '/hold/stampede': return json(await holdStampede(db, url));
				case '/hold/naive': return json(await holdNaive(db, url));
				case '/hold/mixed': return json(await holdMixed(db, url));
				case '/hold/batch-cases': return json(await holdBatchCases(db));

				case '/search/schema': await db.exec(BASE_SCHEMA); await db.exec(SEARCH_HOLD); return json({ ok: true, sizeAfter: await sizeAfter(db) });
				case '/search/seed': return json(await searchSeed(db, url));
				case '/search/detail': return json(await searchDetail(db, url));
				case '/search/stock': return json(await searchStock(db, url));
				case '/search/indexes': return json(await searchIndexes(db));
				case '/search/fts': return json(await searchFts(db));
				case '/search/denorm': return json(await searchDenorm(db));
				case '/search/measure': return json(await searchMeasure(db));
				case '/search/reseed': return json(await searchReseed(db));

				case '/trigram/build': return json(await trigramBuild(db, url));
				case '/trigram/measure': return json(await trigramMeasure(db, url));

				case '/probe/batch': return json(await probeBatch(db, url));
				case '/probe/stmt-bytes': return json(await probeStatementBytes(db, url));
				default: return new Response('not found', { status: 404 });
			}
		}
		catch (e) {
			return json({ error: String((e as Error).message ?? e), stack: (e as Error).stack }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
