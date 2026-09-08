/**
 * Throwaway spike, issue #25 item 2: what does a hand-rolled trigram-overlap table
 * on D1 actually cost?
 *
 * Issue #16 named the mechanism and left it unmeasured, guessing it lands in #13's
 * 113,000-rows-read tail. This measures it: rows read, latency, index size, write
 * amplification on re-seed, and the zero-result-fallback variant.
 *
 * Two corpora, deliberately:
 *
 *  - GENERATED — `spike/d1-search/seed.ts` verbatim, so every number is directly
 *    comparable with #13's. Its vocabulary is 534 distinct terms, which #13 itself
 *    flags as an under-representation.
 *  - REAL — 38,001 real card names from Magic, Pokemon, One Piece and a Riftbound
 *    proxy (see `spike/typo-search/`), sampled to 150,000 Printings. Trigram
 *    selectivity is driven ENTIRELY by vocabulary, so the generated corpus cannot
 *    answer this question and the real one can. Where they disagree, the real
 *    figure is the one that matters and #13's caveat becomes a correction.
 *
 * Everything runs on local workerd/miniflare. The same obligation #13 and #4 left
 * open is left open again: no remote D1 was reachable (see the README).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
	generatePrintings,
	lit,
	packStatements,
} from '../d1-search/seed';
// The 38,001 real card names, produced by `spike/typo-search/`. Imported as a
// module because workerd's filesystem is sandboxed to the spike root.
import realNames from '../typo-search/data/all-card-names.json';

const DB = env.DB;
const BATCH_STATEMENTS = 200;
const MAX_STATEMENT_BYTES = 90_000;
const RUNS = 7;

interface Measured {
	label: string;
	medianMs: number;
	rowsRead: number;
	returned: number;
}
const measurements: Measured[] = [];

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

async function measure(label: string, sql: string, binds: unknown[]): Promise<Measured> {
	const times: number[] = [];
	let rowsRead = 0;
	let returned = 0;
	for (let i = 0; i < RUNS; i++) {
		const t = Date.now();
		const r = await DB.prepare(sql).bind(...binds).all();
		times.push(Date.now() - t);
		rowsRead = (r.meta as { rows_read?: number }).rows_read ?? 0;
		returned = r.results.length;
	}
	const m = { label, medianMs: median(times), rowsRead, returned };
	measurements.push(m);
	// eslint-disable-next-line no-console
	console.log(`  ${label.padEnd(56)} ${String(m.medianMs).padStart(5)} ms  rows_read=${String(rowsRead).padStart(8)}  returned=${returned}`);
	return m;
}

/** D1 reports the database file size after every statement; `pragma_page_count` is refused. */
async function pageCount(): Promise<number> {
	const res = await DB.prepare('SELECT 1').all();
	return (res.meta as { size_after?: number }).size_after ?? -1;
}

/** The fold rule measured in `spike/typo-search/`: apostrophes deleted, everything else spaced. */
function fold(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/['’ʼ‘`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** pg_trgm's trigram set: each word padded with two leading spaces and one trailing. */
function trigramsOf(s: string): string[] {
	const out = new Set<string>();
	for (const w of fold(s).split(' ').filter(Boolean)) {
		const p = `  ${w} `;
		for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
	}
	return [...out];
}

async function runBatches(statements: string[]): Promise<number> {
	let written = 0;
	for (let i = 0; i < statements.length; i += BATCH_STATEMENTS) {
		const chunk = statements.slice(i, i + BATCH_STATEMENTS).map(s => DB.prepare(s));
		const res = await DB.batch(chunk);
		for (const r of res) written += (r.meta as { rows_written?: number }).rows_written ?? 0;
	}
	return written;
}

describe('hand-rolled trigram overlap on D1', () => {
	it('measures the mechanism at 150k Printings on two corpora', async () => {
		// eslint-disable-next-line no-console
		const log = console.log;

		for (const corpus of ['generated', 'real'] as const) {
			log(`\n\n################ CORPUS: ${corpus} ################\n`);

			const printings = generatePrintings();
			if (corpus === 'real') {
				// Same row count, same everything else — only the name vocabulary changes.
				// 150,000 Printings over 38,001 distinct names is the real Catalogue ratio:
				// a card is printed in many sets, variations, finishes and languages.
				for (let i = 0; i < printings.length; i++) {
					printings[i].name = realNames[i % realNames.length];
				}
			}
			const distinctNames = new Set(printings.map(p => p.name));
			log(`Printings: ${printings.length}  distinct names: ${distinctNames.size}`);

			// ---------------------------------------------------------- base table
			await DB.exec('DROP TABLE IF EXISTS printing_trigram;');
			await DB.exec('DROP TABLE IF EXISTS name_trigram;');
			await DB.exec('DROP TABLE IF EXISTS catalogue_name;');
			await DB.exec('DROP TABLE IF EXISTS catalogue_printing;');
			await DB.exec(
				'CREATE TABLE catalogue_printing (id TEXT PRIMARY KEY, game_system TEXT NOT NULL, name TEXT NOT NULL, name_folded TEXT NOT NULL) STRICT;',
			);
			const rows = printings.map(p => `(${lit(p.id)},${lit(p.gameSystem)},${lit(p.name)},${lit(fold(p.name))})`);
			await runBatches(packStatements(
				'INSERT INTO catalogue_printing (id, game_system, name, name_folded) VALUES ',
				rows,
				MAX_STATEMENT_BYTES,
			));
			await DB.exec('CREATE INDEX cp_folded ON catalogue_printing (game_system, name_folded);');
			const afterBase = await pageCount();
			log(`Base table + folded index: ${(afterBase / 1e6).toFixed(1)} MB`);

			// ------------------------------------- shape A: trigram per PRINTING (#16)
			// This is the table #16 describes: one row per (trigram, printing_id).
			await DB.exec('CREATE TABLE printing_trigram (trigram TEXT NOT NULL, printing_id TEXT NOT NULL) STRICT;');
			const trigramRows: string[] = [];
			for (const p of printings) {
				for (const t of trigramsOf(p.name)) trigramRows.push(`(${lit(t)},${lit(p.id)})`);
			}
			log(`Shape A rows: ${trigramRows.length}  (${(trigramRows.length / printings.length).toFixed(1)} per Printing)`);
			const tA0 = Date.now();
			const writtenA = await runBatches(packStatements(
				'INSERT INTO printing_trigram (trigram, printing_id) VALUES ',
				trigramRows,
				MAX_STATEMENT_BYTES,
			));
			const loadA = Date.now() - tA0;
			const beforeIdxA = await pageCount();
			const tIdxA = Date.now();
			await DB.exec('CREATE INDEX pt_trigram ON printing_trigram (trigram, printing_id);');
			const idxA = Date.now() - tIdxA;
			const afterA = await pageCount();
			log(`Shape A: load ${loadA} ms, rows_written=${writtenA}, index built in ${idxA} ms`);
			log(`Shape A size: table ${((beforeIdxA - afterBase) / 1e6).toFixed(1)} MB + index ${((afterA - beforeIdxA) / 1e6).toFixed(1)} MB = ${((afterA - afterBase) / 1e6).toFixed(1)} MB`);
			log(`Shape A write amplification on a full re-seed: ${(writtenA / printings.length).toFixed(1)} billed rows_written per Printing (trigram table alone)`);

			// -------------------------- shape B: trigram per DISTINCT NAME, then join
			// Not considered by #16. The Catalogue has many Printings per name, so
			// indexing the name once and joining is strictly less data for the same
			// answer. Worth measuring because it is the difference between ~3.7M rows
			// and ~1M.
			await DB.exec('CREATE TABLE catalogue_name (name_folded TEXT PRIMARY KEY) STRICT;');
			await runBatches(packStatements(
				'INSERT OR IGNORE INTO catalogue_name (name_folded) VALUES ',
				[...new Set(printings.map(p => fold(p.name)))].map(n => `(${lit(n)})`),
				MAX_STATEMENT_BYTES,
			));
			await DB.exec('CREATE TABLE name_trigram (trigram TEXT NOT NULL, name_folded TEXT NOT NULL) STRICT;');
			const nameTrigramRows: string[] = [];
			for (const n of new Set(printings.map(p => fold(p.name)))) {
				for (const t of trigramsOf(n)) nameTrigramRows.push(`(${lit(t)},${lit(n)})`);
			}
			log(`\nShape B rows: ${nameTrigramRows.length}  (${(nameTrigramRows.length / trigramRows.length * 100).toFixed(1)}% of shape A)`);
			const beforeB = await pageCount();
			const writtenB = await runBatches(packStatements(
				'INSERT INTO name_trigram (trigram, name_folded) VALUES ',
				nameTrigramRows,
				MAX_STATEMENT_BYTES,
			));
			await DB.exec('CREATE INDEX nt_trigram ON name_trigram (trigram, name_folded);');
			await DB.exec('CREATE INDEX cp_folded_join ON catalogue_printing (name_folded);');
			const afterB = await pageCount();
			log(`Shape B size: ${((afterB - beforeB) / 1e6).toFixed(1)} MB, rows_written=${writtenB}`);

			// ------------------------------------------------------------- the queries
			// Pick a real query: a misspelling of a name that exists in this corpus.
			const target = printings[12_345].name;
			const folded = fold(target);
			// One transposition in the middle of the first long word.
			const typo = (() => {
				const w = folded.split(' ').find(x => x.length >= 6) ?? folded;
				const i = Math.floor(w.length / 2);
				const swapped = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
				return folded.replace(w, swapped);
			})();
			const qTrigrams = trigramsOf(typo);
			log(`\nQuery target: "${target}"`);
			log(`Query typed : "${typo}"  -> ${qTrigrams.length} trigrams`);

			// D1 caps bound parameters at 100 (#13, measured), so the IN list must be
			// inlined as literals once a query exceeds 100 trigrams. At these lengths
			// it does not, but the ceiling is real for long names.
			const inList = qTrigrams.map(t => lit(t)).join(',');

			log('\n--- Shape A: trigram per Printing (the #16 mechanism) ---');
			await measure(
				'A1 overlap, GROUP BY printing_id, ORDER BY COUNT(*) DESC LIMIT 20',
				`SELECT printing_id, COUNT(*) AS overlap FROM printing_trigram
				 WHERE trigram IN (${inList})
				 GROUP BY printing_id ORDER BY overlap DESC LIMIT 20`,
				[],
			);
			await measure(
				'A2 the same, joined back to the Printing row for a name',
				`SELECT p.name, t.overlap FROM (
				   SELECT printing_id, COUNT(*) AS overlap FROM printing_trigram
				   WHERE trigram IN (${inList})
				   GROUP BY printing_id ORDER BY overlap DESC LIMIT 20
				 ) t JOIN catalogue_printing p ON p.id = t.printing_id`,
				[],
			);
			await measure(
				'A3 with a minimum-overlap HAVING filter (>= 60% of query trigrams)',
				`SELECT printing_id, COUNT(*) AS overlap FROM printing_trigram
				 WHERE trigram IN (${inList})
				 GROUP BY printing_id HAVING overlap >= ${Math.ceil(qTrigrams.length * 0.6)}
				 ORDER BY overlap DESC LIMIT 20`,
				[],
			);
			await measure(
				'A4 game-scoped (the only shape the storefront ever issues)',
				`SELECT t.printing_id, t.overlap FROM (
				   SELECT printing_id, COUNT(*) AS overlap FROM printing_trigram
				   WHERE trigram IN (${inList})
				   GROUP BY printing_id ORDER BY overlap DESC LIMIT 200
				 ) t JOIN catalogue_printing p ON p.id = t.printing_id
				 WHERE p.game_system = ?1 LIMIT 20`,
				['magic'],
			);

			log('\n--- Shape B: trigram per distinct name, then join ---');
			await measure(
				'B1 overlap over names, then join to Printings',
				`SELECT p.name, t.overlap FROM (
				   SELECT name_folded, COUNT(*) AS overlap FROM name_trigram
				   WHERE trigram IN (${inList})
				   GROUP BY name_folded ORDER BY overlap DESC LIMIT 20
				 ) t JOIN catalogue_printing p ON p.name_folded = t.name_folded LIMIT 20`,
				[],
			);
			await measure(
				'B2 overlap over names only (candidate ids, no join)',
				`SELECT name_folded, COUNT(*) AS overlap FROM name_trigram
				 WHERE trigram IN (${inList})
				 GROUP BY name_folded ORDER BY overlap DESC LIMIT 20`,
				[],
			);

			log('\n--- The exact-hit path this would sit behind ---');
			await measure(
				'C1 folded-column exact hit (the cheap win, item 6)',
				'SELECT id, name FROM catalogue_printing WHERE game_system = ?1 AND name_folded = ?2 LIMIT 20',
				['magic', folded],
			);
			await measure(
				'C2 folded-column MISS (what triggers the fallback)',
				'SELECT id, name FROM catalogue_printing WHERE game_system = ?1 AND name_folded = ?2 LIMIT 20',
				['magic', typo],
			);

			log('\n--- Query plans ---');
			for (const [label, sql] of [
				['A1', `SELECT printing_id, COUNT(*) AS overlap FROM printing_trigram WHERE trigram IN (${inList}) GROUP BY printing_id ORDER BY overlap DESC LIMIT 20`],
				['B2', `SELECT name_folded, COUNT(*) AS overlap FROM name_trigram WHERE trigram IN (${inList}) GROUP BY name_folded ORDER BY overlap DESC LIMIT 20`],
			] as const) {
				const plan = await DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
				log(`  ${label}: ${plan.results.map((r: Record<string, unknown>) => r.detail).join(' | ')}`);
			}

			log('\n--- Trigram selectivity: how many rows one trigram costs ---');
			const sel = await DB.prepare(
				`SELECT trigram, COUNT(*) AS n FROM printing_trigram GROUP BY trigram ORDER BY n DESC LIMIT 8`,
			).all();
			log(`  most common: ${sel.results.map((r: Record<string, unknown>) => `${JSON.stringify(r.trigram)}=${r.n}`).join(' ')}`);
			const distinctT = await DB.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT trigram FROM printing_trigram)').first<{ n: number }>();
			log(`  distinct trigrams in shape A: ${distinctT?.n}`);
			const qCost = await DB.prepare(
				`SELECT COUNT(*) AS n FROM printing_trigram WHERE trigram IN (${inList})`,
			).first<{ n: number }>();
			log(`  rows the IN list touches for this one query: ${qCost?.n}`);

			log('\n--- Write amplification: a 2,000-Printing delta re-seed ---');
			const delta = printings.slice(0, 2_000);
			const t0 = Date.now();
			const ids = delta.map(p => lit(p.id)).join(',');
			const del = await DB.prepare(`DELETE FROM printing_trigram WHERE printing_id IN (${ids.slice(0, 90_000)})`).run();
			const reRows: string[] = [];
			for (const p of delta) for (const t of trigramsOf(p.name)) reRows.push(`(${lit(t)},${lit(p.id)})`);
			const reWritten = await runBatches(packStatements('INSERT INTO printing_trigram (trigram, printing_id) VALUES ', reRows, MAX_STATEMENT_BYTES));
			log(`  2,000 Printings re-synced in ${Date.now() - t0} ms: deleted ${(del.meta as { rows_written?: number }).rows_written ?? 0} + wrote ${reWritten} = ${(((del.meta as { rows_written?: number }).rows_written ?? 0) + reWritten) / 2000} billed rows per Printing`);
		}

		expect(measurements.length).toBeGreaterThan(0);
	}, 1_800_000);
});
