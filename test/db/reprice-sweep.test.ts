import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { printing, repriceSweep, sku } from '../../server/db/schema';
import { setExchangeRateManually } from '../../server/fx/exchange-rate';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { drainSweep, readRepriceProgress, requestSweep, runSweepChunk } from '../../server/pricing/sweep';
import { memoryQueue } from '../support/reprice';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

const PIKACHU = 'prt-pokemon-base1-58';
const LOTUS = 'prt-magic-lea-232';

let tick = 1_900_000_000_000;
const now = () => (tick += 1_000);

async function priced(printingId: string, condition: string, language = 'en') {
	const rows = await db.select({ id: sku.id, condition: sku.condition, language: sku.language, onHand: sku.onHand, sellPrice: sku.sellPrice, buyPrice: sku.buyPrice, pricedAt: sku.pricedAt, sellPriceSource: sku.sellPriceSource, buyPriceSource: sku.buyPriceSource }).from(sku).where(eq(sku.printingId, printingId));
	return rows.find(row => row.condition === condition && row.language === language)!;
}

async function pin(printingId: string, condition: string, side: 'sell' | 'buy', price: number) {
	const row = await priced(printingId, condition);
	await db.update(sku).set(side === 'sell'
		? { sellPrice: price as never, sellPriceSource: 'pinned', sellPinnedSessionId: 'sess_counter_1', sellPinnedAt: now() }
		: { buyPrice: price as never, buyPriceSource: 'pinned', buyPinnedSessionId: 'sess_counter_1', buyPinnedAt: now() }).where(eq(sku.id, row.id));
}

function hold(printingId: string, condition: 'NM' | 'LP' | 'MP' | 'HP', delta: number) {
	return recordAdjustment(db, { printingId, condition, language: 'en', change: { delta }, reason: delta > 0 ? 'found' : 'shrinkage' }, STAFF_ACTOR);
}

describe('the reprice sweep (spec §6, _The sweep_: one job per Store, chunked by cursor, pins skipped)', () => {
	beforeEach(async () => {
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await seedPrinting(db, { id: LOTUS, cardId: 'card-magic-black-lotus', gameSystem: 'magic', name: 'Black Lotus', setCode: 'lea', collectorNumber: '232', rarity: 'rare', marketPrice: 1_000_000, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		// Held before any exchange rate exists, so every stored price starts null.
		await hold(PIKACHU, 'NM', 4);
		await hold(PIKACHU, 'LP', 1);
		await hold(LOTUS, 'MP', 1);
		await hold(PIKACHU, 'HP', 1);
		await hold(PIKACHU, 'HP', -1);
		await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.79, sessionId: 'sess_counter_1', queue: memoryQueue(), now: now() });
		// The step asked for a sweep of its own; settled here so each case starts with nothing queued and every price still null.
		await db.update(repriceSweep).set({ status: 'done', finishedAt: now() });
	});

	it('prices every SKU on hand from the Pricing Rules at the rate in force, and leaves a zero-stock unpinned row alone', async () => {
		expect(await priced(PIKACHU, 'NM')).toMatchObject({ sellPrice: null, buyPrice: null });
		const { sweepId } = await requestSweep(db, memoryQueue(), { reason: 'manual', games: null, watermark: false, now: now() });

		const outcome = await drainSweep(db, { sweepId, now: now() });

		expect(outcome).toMatchObject({ status: 'done', done: 3, total: 3, finished: true });
		// $2.40 at 0.79 is £1.90: Sell 100 % rounded up to 10p; Buy 50 % rounded down to 5p.
		expect(await priced(PIKACHU, 'NM')).toMatchObject({ sellPrice: 190, buyPrice: 95, pricedAt: tick });
		expect(await priced(PIKACHU, 'LP')).toMatchObject({ sellPrice: 170, buyPrice: 75 });
		// $10,000 is £7,900: Moderately Played sells at 70 % then the 110 % band; buys at 60 % then 65 %.
		expect(await priced(LOTUS, 'MP')).toMatchObject({ sellPrice: 608300, buyPrice: 308100 });
		expect(await priced(PIKACHU, 'HP')).toMatchObject({ onHand: 0, sellPrice: null, buyPrice: null });
		expect(await readRepriceProgress(db)).toMatchObject({ id: sweepId, status: 'done', done: 3, total: 3, finishedAt: tick });
	});

	it('skips a pinned side, reprices the other, and visits a pinned row at on-hand 0', async () => {
		await pin(PIKACHU, 'NM', 'sell', 500);
		await pin(PIKACHU, 'HP', 'buy', 1);
		await pin(PIKACHU, 'LP', 'sell', 300);
		await pin(PIKACHU, 'LP', 'buy', 100);
		const { sweepId } = await requestSweep(db, memoryQueue(), { reason: 'manual', games: null, watermark: false, now: now() });

		const outcome = await drainSweep(db, { sweepId, now: now() });

		// Pikachu LP is pinned on both sides: nothing to write, so it is not in the count.
		expect(outcome).toMatchObject({ done: 3, total: 3 });
		expect(await priced(PIKACHU, 'NM')).toMatchObject({ sellPrice: 500, sellPriceSource: 'pinned', buyPrice: 95 });
		expect(await priced(PIKACHU, 'HP')).toMatchObject({ onHand: 0, sellPrice: 100, buyPrice: 1, buyPriceSource: 'pinned' });
		expect(await priced(PIKACHU, 'LP')).toMatchObject({ sellPrice: 300, buyPrice: 100 });
	});

	it('scopes to the games asked for', async () => {
		const { sweepId } = await requestSweep(db, memoryQueue(), { reason: 'settings', games: ['magic'], watermark: false, now: now() });
		expect(await drainSweep(db, { sweepId, now: now() })).toMatchObject({ done: 1, total: 1 });
		expect(await priced(LOTUS, 'MP')).toMatchObject({ sellPrice: 608300 });
		expect(await priced(PIKACHU, 'NM')).toMatchObject({ sellPrice: null });
	});

	it('on a Market Price change, reprices only SKUs whose priced_at is behind the watermark', async () => {
		await drainSweep(db, { sweepId: (await requestSweep(db, memoryQueue(), { reason: 'manual', games: null, watermark: false, now: now() })).sweepId, now: now() });
		const pricedAt = (await priced(PIKACHU, 'NM')).pricedAt!;
		// The Catalogue moves Pikachu; Black Lotus stays.
		await db.update(printing).set({ marketPrice: 300, marketPriceUpdatedAt: now() }).where(eq(printing.id, PIKACHU));
		const { sweepId } = await requestSweep(db, memoryQueue(), { reason: 'market_price', games: ['pokemon'], watermark: true, now: now() });

		const outcome = await drainSweep(db, { sweepId, now: now() });

		expect(outcome).toMatchObject({ done: 2, total: 2 });
		expect(await priced(PIKACHU, 'NM')).toMatchObject({ sellPrice: 240, buyPrice: 115, pricedAt: tick });
		expect(await priced(LOTUS, 'MP')).toMatchObject({ pricedAt });
	});

	it('runs a chunk per message and reports progress; a request folded in mid-flight sends it back to the start, widened', async () => {
		const queue = memoryQueue();
		const { sweepId } = await requestSweep(db, queue, { reason: 'settings', games: ['pokemon'], watermark: false, now: now() });
		expect(queue.sent).toEqual([{ sweepId }]);

		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ status: 'running', done: 1, total: 2, finished: false });
		const folded = await requestSweep(db, queue, { reason: 'settings', games: ['magic'], watermark: false, now: now() });
		expect(folded).toEqual({ sweepId, folded: true });
		expect(queue.sent).toHaveLength(1);
		expect(await readRepriceProgress(db)).toMatchObject({ status: 'running', games: ['pokemon', 'magic'], done: 0, total: 3 });

		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ done: 1, total: 3, finished: false });
		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ done: 2, finished: false });
		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ done: 3, finished: false });
		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ status: 'done', done: 3, total: 3, finished: true });
		expect(await priced(LOTUS, 'MP')).toMatchObject({ sellPrice: 608300 });
		expect(await priced(PIKACHU, 'LP')).toMatchObject({ sellPrice: 170 });

		// A replayed message for a settled job does nothing.
		expect(await runSweepChunk(db, { sweepId, chunk: 1, now: now() })).toMatchObject({ status: 'done', finished: true });
		const next = await requestSweep(db, queue, { reason: 'manual', games: null, watermark: false, now: now() });
		expect(next.folded).toBe(false);
		expect(queue.sent).toHaveLength(2);
	});
});
