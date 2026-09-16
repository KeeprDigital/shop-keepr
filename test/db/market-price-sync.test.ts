import type { CataloguePage, Cursor, MarketPricePage } from '../../server/catalogue/generated/types.gen';
import type { SyncOutcome } from '../../server/catalogue/sync/run';
import type { FixturePages } from '../support/fixture-fetch';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogueClient, FIRST_CURSOR } from '../../server/catalogue/client';
import { claimRun, failRun, runMarketPriceSync, storedCursor } from '../../server/catalogue/sync/run';
import { createDb } from '../../server/db/client';
import { catalogueQuarantine, printing, printingDetail, syncRun } from '../../server/db/schema';
import { readRepriceProgress } from '../../server/pricing/sweep';
import { fixtureFetchFrom } from '../support/fixture-fetch';
import { committedPages, fixturePrinting, syncFixture } from '../support/fixture-mirror';
import { memoryQueue } from '../support/reprice';

const baseURL = 'https://catalogue.test/api';
const credential = 'shop-keepr-test-key';

const LAST_MAGIC_PRICE_CURSOR = 'magic-price-0017';
const bolt = 'prt-magic-m10-146';

/** `base` with `records` served as the one Magic price page after `after`, for a delta walk. */
function priceDelta(records: MarketPricePage['records'], after: Cursor = LAST_MAGIC_PRICE_CURSOR, base: FixturePages = committedPages): FixturePages {
	const pages = new Map(base);
	const next = records.at(-1)!.cursor;
	pages.set(`games/magic/market-prices/${after}.json`, { records, next_cursor: next, has_more: false });
	pages.set(`games/magic/market-prices/${next}.json`, { records: [], next_cursor: next, has_more: false });
	return pages;
}

function movement(printingId: string, amount: number | null, cursor: Cursor = 'magic-price-0099'): MarketPricePage['records'][number] {
	return { cursor, game: 'magic', printing_id: printingId, market_price: amount === null ? null : { amount, currency: 'USD' } };
}

let tick = 1_900_000_000_000;

/** One Market Price run; a full walk unless told to resume from the stored cursor. */
function walkPrices(pages: FixturePages = committedPages, { game = 'magic', from = 'zero', reprice }: { game?: string; from?: 'zero' | 'stored'; reprice?: ReturnType<typeof memoryQueue> } = {}) {
	const client = createCatalogueClient({ fetch: fixtureFetchFrom(pages, { baseURL, credential }), baseURL, credential });
	return runMarketPriceSync({ db: env.DB, client, game, fromCursor: from === 'zero' ? FIRST_CURSOR : undefined, now: () => (tick += 1_000), reprice });
}

function completed(outcome: SyncOutcome) {
	if (!outcome.claimed) {
		throw new Error('run was refused');
	}
	return outcome.run;
}

const db = () => createDb(env.DB);
const readPrinting = (id: string) => db().query.printing.findFirst({ where: eq(printing.id, id) });

describe('the Market Price walk (ADR 0009: the run only ever carries movements)', () => {
	it('after a seed, applies only the movements the Catalogue record did not carry, and moves the watermark for those rows alone', async () => {
		await syncFixture('magic');
		const before = new Map((await db().query.printing.findMany()).map(r => [r.id, r]));

		const run = completed(await walkPrices());
		// The fixture's last movement is a null for m10-15: quarantined, so the run says so.
		expect(run).toMatchObject({ kind: 'market_price', gameSystem: 'magic', status: 'completed_with_drift', cursorFrom: '0', cursorTo: LAST_MAGIC_PRICE_CURSOR });
		expect(run.counts).toEqual({ seen: 17, written: 1, quarantined: 1, drifted: 0, skipped: 0 });

		for (const row of await db().query.printing.findMany()) {
			if (row.id === 'prt-magic-m10-15') {
				expect(row).toMatchObject({ marketPrice: 120, marketPriceCurrency: 'USD', marketPriceCursor: 'magic-price-0007' });
				expect(row.marketPriceUpdatedAt).toBeGreaterThan(before.get(row.id)!.syncedAt);
			}
			else {
				expect(row).toEqual(before.get(row.id));
			}
		}
		expect(await db().query.syncRun.findFirst({ where: eq(syncRun.id, run.id) })).toMatchObject({ kind: 'market_price', recordsWritten: 1, recordsQuarantined: 1, recordsSkipped: 0 });
	});

	it('applies a delta to the row whose rate moved and leaves every other row as it was', async () => {
		await syncFixture('magic');
		await walkPrices();
		const before = new Map((await db().query.printing.findMany()).map(r => [r.id, r]));

		const run = completed(await walkPrices(priceDelta([movement(bolt, 260)]), { from: 'stored' }));
		expect(run).toMatchObject({ status: 'completed', cursorFrom: LAST_MAGIC_PRICE_CURSOR, cursorTo: 'magic-price-0099' });
		expect(run.counts).toEqual({ seen: 1, written: 1, quarantined: 0, drifted: 0, skipped: 0 });

		for (const row of await db().query.printing.findMany()) {
			if (row.id === bolt) {
				expect(row).toMatchObject({ marketPrice: 260, marketPriceCurrency: 'USD', marketPriceCursor: 'magic-price-0099', cursor: before.get(bolt)!.cursor, syncedAt: before.get(bolt)!.syncedAt });
				expect(row.marketPriceUpdatedAt).toBeGreaterThan(before.get(bolt)!.marketPriceUpdatedAt!);
			}
			else {
				expect(row).toEqual(before.get(row.id));
			}
		}
	});

	it('leaves the stored Market Price alone on a null, quarantines the record, and logs loudly', async () => {
		await syncFixture('magic');
		await walkPrices(priceDelta([movement(bolt, 240, 'magic-price-0002')], FIRST_CURSOR));
		const before = (await readPrinting(bolt))!;
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const run = completed(await walkPrices(priceDelta([movement(bolt, null)], 'magic-price-0002'), { from: 'stored' }));
			expect(run).toMatchObject({ status: 'completed_with_drift', cursorTo: 'magic-price-0099' });
			expect(run.counts).toEqual({ seen: 1, written: 0, quarantined: 1, drifted: 0, skipped: 0 });
			expect(await readPrinting(bolt)).toEqual(before);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/null Market Price.*prt-magic-m10-146/));
			const [quarantined] = await db().query.catalogueQuarantine.findMany();
			expect(quarantined).toMatchObject({ syncRunId: run.id, kind: 'market_price', recordId: bolt, cursor: 'magic-price-0099', reason: 'null_market_price' });
			expect(JSON.parse(quarantined!.detail)).toEqual({ heldMarketPrice: 240, heldCurrency: 'USD' });
		}
		finally {
			warn.mockRestore();
		}
	});

	it('skips and counts a movement for a Printing the Mirror does not hold', async () => {
		await syncFixture('magic');
		await walkPrices();
		const before = await db().query.printing.findMany();

		const run = completed(await walkPrices(priceDelta([movement('prt-magic-not-yet-mirrored', 500)]), { from: 'stored' }));
		expect(run.status).toBe('completed');
		expect(run.counts).toEqual({ seen: 1, written: 0, quarantined: 0, drifted: 0, skipped: 1 });
		expect(await db().query.printing.findMany()).toEqual(before);
	});

	it('asks for a watermark-driven reprice sweep of the game when it moved a price, and none when it did not (spec §5)', async () => {
		await syncFixture('magic');
		await walkPrices();
		const reprice = memoryQueue();

		completed(await walkPrices(priceDelta([movement(bolt, 999, 'magic-price-0001')]), { from: 'stored', reprice }));
		expect(reprice.sent).toEqual([]);
		expect(await readRepriceProgress(db())).toBeNull();

		// The stored cursor now stands at that movement's; the next delta walks on from it.
		completed(await walkPrices(priceDelta([movement(bolt, 260)], 'magic-price-0001'), { from: 'stored', reprice }));
		expect(reprice.sent).toHaveLength(1);
		expect(await readRepriceProgress(db())).toMatchObject({ id: reprice.sent[0]!.sweepId, status: 'queued', reason: 'market_price', games: ['magic'], watermark: true });
	});

	it('leaves a rate alone when the movement is behind the price cursor held', async () => {
		await syncFixture('magic');
		await walkPrices();
		const before = (await readPrinting(bolt))!;

		const run = completed(await walkPrices(priceDelta([movement(bolt, 999, 'magic-price-0001')]), { from: 'stored' }));
		expect(run.counts.written).toBe(0);
		expect(await readPrinting(bolt)).toEqual(before);
	});

	it('quarantines a malformed movement with its raw payload and completes with drift', async () => {
		await syncFixture('magic');
		await walkPrices();
		const raw = { cursor: 'magic-price-0099', game: 'magic', printing_id: bolt, market_price: { amount: 'lots', currency: 'USD' } };

		const run = completed(await walkPrices(priceDelta([raw as never]), { from: 'stored' }));
		expect(run.status).toBe('completed_with_drift');
		expect(run.counts).toEqual({ seen: 1, written: 0, quarantined: 1, drifted: 0, skipped: 0 });
		const quarantined = (await db().query.catalogueQuarantine.findMany({ where: eq(catalogueQuarantine.syncRunId, run.id) })).map(q => ({ ...q, raw: JSON.parse(q.raw) }));
		expect(quarantined).toEqual([expect.objectContaining({ syncRunId: run.id, kind: 'market_price', gameSystem: 'magic', recordKind: null, recordId: bolt, cursor: 'magic-price-0099', reason: 'validation_failed', raw })]);
		expect(await readPrinting(bolt)).toMatchObject({ marketPrice: 240 });
	});

	it('carries the movement into the verbatim record and the search copy, so a full Catalogue walk finds no drift', async () => {
		await syncFixture('magic');
		await walkPrices(priceDelta([movement(bolt, 260)], FIRST_CURSOR));

		const moved = { ...fixturePrinting(bolt), market_price: { amount: 260, currency: 'USD' }, market_price_cursor: 'magic-price-0099' };
		const detail = await db().query.printingDetail.findFirst({ where: eq(printingDetail.printingId, bolt) });
		expect(JSON.parse(detail!.record)).toEqual(moved);
		const search = await env.DB.prepare('SELECT market_price FROM mtg_printing WHERE id = ?1').bind(bolt).first<{ market_price: number }>();
		expect(search).toEqual({ market_price: 260 });

		// The Catalogue now returns the Printing record priced as the movement said.
		const catalogue = new Map(committedPages);
		for (const [path, body] of catalogue) {
			if (path.startsWith('games/magic/catalogue/')) {
				const page = body as CataloguePage;
				catalogue.set(path, { ...page, records: page.records.map(r => (r.kind === 'printing' && r.id === bolt ? moved : r)) });
			}
		}
		const reconcile = await syncFixture('magic', { pages: catalogue });
		expect(reconcile.counts).toEqual({ seen: 44, written: 0, quarantined: 0, drifted: 0, skipped: 0 });
	});

	it('walks on its own cursor and its own lock: a held or failed Catalogue run never stalls it', async () => {
		await syncFixture('magic');
		const held = await claimRun(env.DB, { kind: 'catalogue', game: 'magic', now: tick });
		expect(held.claimed).toBe(true);

		const run = completed(await walkPrices());
		expect(run).toMatchObject({ kind: 'market_price', status: 'completed_with_drift', cursorTo: LAST_MAGIC_PRICE_CURSOR });

		await failRun(env.DB, { runId: (held as { runId: string }).runId, now: tick, error: 'the Catalogue is down' });
		const again = completed(await walkPrices(priceDelta([movement(bolt, 260)]), { from: 'stored' }));
		expect(again).toMatchObject({ status: 'completed', cursorFrom: LAST_MAGIC_PRICE_CURSOR, cursorTo: 'magic-price-0099' });

		const statuses = (await db().query.syncRun.findMany()).map(r => `${r.kind}:${r.status}`).sort();
		expect(statuses).toEqual(['catalogue:completed', 'catalogue:failed', 'market_price:completed', 'market_price:completed_with_drift']);
		expect(await storedCursor(env.DB, 'catalogue', 'magic')).toBe('magic-0044');
	});

	it('refuses a second Market Price run while one is running', async () => {
		await syncFixture('magic');
		const held = await claimRun(env.DB, { kind: 'market_price', game: 'magic', fromCursor: FIRST_CURSOR, now: tick });
		expect(held.claimed).toBe(true);
		expect(await walkPrices(committedPages, { game: 'pokemon' })).toEqual({ claimed: false, reason: 'running' });
	});
});
