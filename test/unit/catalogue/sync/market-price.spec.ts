import type { ParsedRecord } from '../../../../server/catalogue/client';
import type { MarketPriceRecord, PrintingRecord } from '../../../../server/catalogue/generated/types.gen';
import type { HeldPrice } from '../../../../server/catalogue/sync/market-price';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../../../../server/catalogue/sync/hash';
import { planMarketPricePage } from '../../../../server/catalogue/sync/market-price';
import { fixturePrintings } from '../../../support/catalogue-fixture';

const magic = fixturePrintings().filter(r => r.game === 'magic');
const bolt = magic.find(r => r.id === 'prt-magic-m10-146')!;
const ok = (records: MarketPriceRecord[]): ParsedRecord<MarketPriceRecord>[] => records.map(record => ({ ok: true, record }));

/** The Mirror as the Catalogue walk left it: every Printing priced as its record says. */
function held(records: PrintingRecord[]): Map<string, HeldPrice> {
	return new Map(records.map(record => [record.id, {
		marketPrice: record.market_price?.amount ?? null,
		marketPriceCurrency: record.market_price?.currency ?? null,
		marketPriceCursor: record.market_price === null ? null : record.market_price_cursor,
		record,
	}]));
}

function movement(printingId: string, amount: number | null, cursor = 'magic-price-0099'): MarketPriceRecord {
	return { cursor, game: 'magic', printing_id: printingId, market_price: amount === null ? null : { amount, currency: 'USD' } };
}

describe('planning a Market Price page (ADR 0009: the run only ever carries movements)', () => {
	it('writes a Printing whose rate moved, with its detail record carrying the new price', async () => {
		const plan = await planMarketPricePage(ok([movement(bolt.id, 260)]), held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 1, quarantined: 0, drifted: 0, skipped: 0 });
		expect(plan.moved).toHaveLength(1);
		const write = plan.moved[0]!;
		expect(write.record.printing_id).toBe(bolt.id);
		expect(write.detail).toEqual({ ...bolt, market_price: { amount: 260, currency: 'USD' }, market_price_cursor: 'magic-price-0099' });
		expect(write.hash).toBe(await contentHash(write.detail));
	});

	it('writes nothing for a rate the Mirror already holds', async () => {
		const plan = await planMarketPricePage(ok([movement(bolt.id, 240, 'magic-price-0002')]), held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 0, drifted: 0, skipped: 0 });
		expect(plan.moved).toEqual([]);
	});

	it('quarantines a null Market Price with the one held, and leaves the row alone', async () => {
		const plan = await planMarketPricePage(ok([movement(bolt.id, null)]), held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 1, drifted: 0, skipped: 0 });
		expect(plan.moved).toEqual([]);
		expect(plan.quarantined).toEqual([expect.objectContaining({ reason: 'null_market_price', recordId: bolt.id, cursor: 'magic-price-0099', detail: { heldMarketPrice: 240, heldCurrency: 'USD' } })]);
	});

	it('skips and counts a movement for a Printing the Mirror does not hold', async () => {
		const plan = await planMarketPricePage(ok([movement('prt-magic-unknown', 500)]), held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 0, drifted: 0, skipped: 1 });
		expect(plan.missing).toEqual(['prt-magic-unknown']);
	});

	it('leaves a rate alone when the movement is behind the price cursor held', async () => {
		const plan = await planMarketPricePage(ok([movement(bolt.id, 999, 'magic-price-0001')]), held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 0, drifted: 0, skipped: 0 });
		expect(plan.moved).toEqual([]);
	});

	it('prices a Printing that arrived unpriced', async () => {
		const unpriced = magic.find(r => r.market_price === null)!;
		const plan = await planMarketPricePage(ok([movement(unpriced.id, 120)]), held(magic));
		expect(plan.counts.written).toBe(1);
		expect(plan.moved[0]!.detail.market_price).toEqual({ amount: 120, currency: 'USD' });
	});

	it('quarantines a record that fails validation', async () => {
		const raw = { cursor: 'magic-price-0099', game: 'magic', printing_id: bolt.id, market_price: { amount: 'lots' } };
		const plan = await planMarketPricePage([{ ok: false, raw, issues: [] }], held(magic));
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 1, drifted: 0, skipped: 0 });
		expect(plan.quarantined[0]).toMatchObject({ reason: 'validation_failed', recordKind: null, recordId: bolt.id, cursor: 'magic-price-0099', raw });
	});
});
