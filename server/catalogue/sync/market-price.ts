/**
 * The Market Price run (ADR 0009; spec §5, _Price recompute is
 * watermark-driven_): the second walk on the Catalogue's cursor rules,
 * returning only price movements, so prices refresh on a cadence of their
 * own without re-reading card facts. This is the judgement half, kept free
 * of D1 so it is unit-testable against the fixture: given one page of
 * movements and what the Mirror holds for those Printings, decide what
 * moved.
 *
 * - A movement applies only when the rate differs from the one held, so
 *   `market_price_updated_at` means _moved_ and the reprice sweep's
 *   watermark is exact.
 * - A null rate never overwrites a good one; it is skipped, counted, and
 *   named so the run can log it loudly.
 * - A movement for a Printing the Mirror lacks is skipped and counted:
 *   the Printing record carries its price, so the Catalogue walk brings it.
 * - A movement behind the price cursor held is left alone.
 * - The verbatim record in `printing_detail` takes the new price and cursor
 *   too, so the Mirror stays what the Catalogue would return and the next
 *   full walk finds no drift.
 */
import type { D1Client } from '../../db/client';
import type { CatalogueClient, ParsedRecord } from '../client';
import type { MarketPriceRecord, PrintingRecord } from '../generated/types.gen';
import type { PageCounts, Quarantined } from './plan';
import type { PageOptions, PageResult } from './run';
import type { PageWriteContext } from './statements';
import { literal, packRows, tuple } from '../../db/sql';
import { searchPriceStatements } from '../../search/mirror';
import { newId } from '../../utils/ids';
import { contentHash } from './hash';
import { quarantined } from './plan';
import { quarantineStatements, runProgressStatement } from './statements';

/** What the Mirror holds for one Printing a page names: its rate columns and its verbatim record. */
export interface HeldPrice {
	marketPrice: number | null;
	marketPriceCurrency: string | null;
	marketPriceCursor: string | null;
	record: PrintingRecord;
}

export interface PriceWrite {
	record: MarketPriceRecord;
	/** The verbatim record as the Catalogue would now return it. */
	detail: PrintingRecord;
	hash: string;
}

export interface MarketPricePlan {
	moved: PriceWrite[];
	/** Printings whose movement carried a null rate, left as they were. */
	nulls: string[];
	/** Printings the Mirror does not hold. */
	missing: string[];
	quarantined: Quarantined[];
	counts: PageCounts;
}

export async function planMarketPricePage(records: ParsedRecord<MarketPriceRecord>[], held: ReadonlyMap<string, HeldPrice>): Promise<MarketPricePlan> {
	const plan: MarketPricePlan = {
		moved: [],
		nulls: [],
		missing: [],
		quarantined: [],
		counts: { seen: records.length, written: 0, quarantined: 0, drifted: 0, skipped: 0 },
	};
	for (const parsed of records) {
		if (!parsed.ok) {
			plan.quarantined.push(quarantined(parsed.raw, 'validation_failed', { issues: parsed.issues }));
			plan.counts.quarantined += 1;
			continue;
		}
		const record = parsed.record;
		const current = held.get(record.printing_id);
		if (!current) {
			plan.missing.push(record.printing_id);
			plan.counts.skipped += 1;
			continue;
		}
		if (record.market_price === null) {
			plan.nulls.push(record.printing_id);
			plan.counts.skipped += 1;
			continue;
		}
		if (current.marketPriceCursor !== null && record.cursor < current.marketPriceCursor) {
			continue;
		}
		if (current.marketPrice === record.market_price.amount && current.marketPriceCurrency === record.market_price.currency) {
			continue;
		}
		const detail: PrintingRecord = { ...current.record, market_price: record.market_price, market_price_cursor: record.cursor };
		plan.moved.push({ record, detail, hash: await contentHash(detail) });
		plan.counts.written += 1;
	}
	return plan;
}

/**
 * The D1 half: pull one page of movements, judge it against the Mirror,
 * apply it as one `batch()`. Every dependent statement carries its own
 * guard in SQL (spec §4.1; ADR 0011): a rate applies only when it differs
 * from the one held and is not behind the price cursor held, so a replayed
 * page moves no watermark twice; the detail record follows only once the
 * row holds that price cursor; the search table's copy is read back from
 * `printing`. The run's progress row is the last statement, and whether it
 * changed is what the caller checks the lock by.
 */
export async function marketPricePage(db: D1Client, client: CatalogueClient, options: PageOptions): Promise<PageResult> {
	const page = await client.walkMarketPrices(options.game, options.cursor);
	const held = await readHeldPrices(db, options.game, page.records.flatMap(r => (r.ok ? [r.record.printing_id] : [])));
	const plan = await planMarketPricePage(page.records, held);
	const statements = marketPriceStatements(plan, { ...options, nextCursor: page.nextCursor, newId });
	const results = await db.batch(statements.map(sql => db.prepare(sql)));
	const prefix = `[market price sync] ${options.game}`;
	if (plan.nulls.length > 0) {
		console.warn(`${prefix}: the Catalogue sent a null rate for ${plan.nulls.length} Printing(s) at cursor ${options.cursor}; last known rate kept for each: ${plan.nulls.join(', ')}`);
	}
	if (plan.missing.length > 0) {
		console.warn(`${prefix}: skipped ${plan.missing.length} movement(s) for Printing(s) the Mirror does not hold: ${plan.missing.join(', ')}`);
	}
	if (plan.quarantined.length > 0) {
		console.warn(`${prefix}: quarantined ${plan.quarantined.length} record(s) at cursor ${options.cursor}:`, plan.quarantined.map(q => `${q.recordId ?? '?'} (${q.reason})`).join(', '));
	}
	return { nextCursor: page.nextCursor, hasMore: page.hasMore, applied: results.at(-1)!.meta.changes === 1 };
}

/** The rate columns and verbatim record of every Printing of `game` the page names, in one `batch()`. */
async function readHeldPrices(db: D1Client, game: string, printingIds: string[]): Promise<Map<string, HeldPrice>> {
	const held = new Map<string, HeldPrice>();
	if (printingIds.length === 0) {
		return held;
	}
	const selects = packRows(
		`SELECT p.id, p.market_price, p.market_price_currency, p.market_price_cursor, d.record FROM printing p JOIN printing_detail d ON d.printing_id = p.id WHERE p.game_system = ${literal(game)} AND p.id IN (`,
		printingIds.map(literal),
		')',
	);
	const results = await db.batch<{ id: string; market_price: number | null; market_price_currency: string | null; market_price_cursor: string | null; record: string }>(selects.map(sql => db.prepare(sql)));
	for (const row of results.flatMap(result => result.results)) {
		held.set(row.id, {
			marketPrice: row.market_price,
			marketPriceCurrency: row.market_price_currency,
			marketPriceCursor: row.market_price_cursor,
			record: JSON.parse(row.record) as PrintingRecord,
		});
	}
	return held;
}

/** Every statement of the page, in the order the batch must run them. */
export function marketPriceStatements(plan: MarketPricePlan, ctx: PageWriteContext): string[] {
	const ids = plan.moved.map(w => w.record.printing_id);
	return [
		...packRows(
			`UPDATE printing SET market_price = v.amount, market_price_currency = v.currency, market_price_cursor = v.cursor, market_price_updated_at = ${literal(ctx.now)}`
			+ ` FROM (SELECT column1 AS id, column2 AS amount, column3 AS currency, column4 AS cursor FROM (VALUES `,
			plan.moved.map(({ record }) => tuple([record.printing_id, record.market_price!.amount, record.market_price!.currency, record.cursor])),
			`)) AS v WHERE printing.id = v.id`
			+ ` AND (printing.market_price IS NOT v.amount OR printing.market_price_currency IS NOT v.currency)`
			+ ` AND (printing.market_price_cursor IS NULL OR v.cursor >= printing.market_price_cursor)`,
		),
		...packRows(
			`UPDATE printing_detail SET record = v.record, content_hash = v.hash FROM (SELECT column1 AS id, column2 AS record, column3 AS hash, column4 AS cursor FROM (VALUES `,
			plan.moved.map(({ record, detail, hash }) => tuple([record.printing_id, JSON.stringify(detail), hash, record.cursor])),
			`)) AS v WHERE printing_detail.printing_id = v.id AND EXISTS (SELECT 1 FROM printing WHERE printing.id = v.id AND printing.market_price_cursor = v.cursor)`,
		),
		...searchPriceStatements(ctx.game, ids),
		...quarantineStatements(plan.quarantined, ctx),
		runProgressStatement(plan, ctx),
	];
}
