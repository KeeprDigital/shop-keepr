import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { sku } from '../../server/db/schema';
import { setExchangeRateManually } from '../../server/fx/exchange-rate';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { quotePrinting } from '../../server/pricing/quote';
import { writePricingSetting } from '../../server/pricing/settings';
import { memoryQueue } from '../support/reprice';
import { PIKACHU_NM, seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

let tick = 1_900_000_000_000;
const now = () => (tick += 1_000);

describe('a Printing priced on read (spec §6: no SKU row is ever materialised speculatively)', () => {
	beforeEach(async () => {
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await seedPrinting(db, { id: 'prt-pokemon-base1-4', cardId: 'card-pokemon-charizard', name: 'Charizard', collectorNumber: '4', rarity: 'rare_holo', marketPrice: null, marketPriceCurrency: null });
		await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.79, sessionId: 'sess_counter_1', queue: memoryQueue(), now: now() });
		await writePricingSetting(db, { scope: 'store', ref: { side: 'buy', key: 'qtyBands' }, value: [{ from: 1, k: 1, f: 0 }, { from: 4, k: 0.9, f: 0 }] }, { queue: memoryQueue(), now: now() });
	});

	it('prices a never-held card through the same evaluator at on-hand 0, without creating a row', async () => {
		const quote = await quotePrinting(db, { ...PIKACHU_NM });
		expect(quote).toEqual({
			skuId: null,
			onHand: 0,
			marketPrice: 240,
			marketPriceCurrency: 'USD',
			sellPrice: 190,
			sellPriceSource: 'rule',
			buyPrice: 95,
			buyPriceSource: 'rule',
			buyPriceAtOne: 95,
		});
		expect(await db.select().from(sku)).toEqual([]);
	});

	it('takes the line quantity into the Buy Price and reports the unit price at one beside it', async () => {
		const quote = await quotePrinting(db, { ...PIKACHU_NM, quantity: 4 });
		expect(quote).toMatchObject({ buyPrice: 85, buyPriceAtOne: 95, sellPrice: 190 });
	});

	it('reads the stored row where one exists: its on-hand, and a pin as final', async () => {
		await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 2 }, reason: 'found' }, STAFF_ACTOR);
		const held = await quotePrinting(db, { ...PIKACHU_NM });
		expect(held).toMatchObject({ onHand: 2, sellPrice: 190, buyPrice: 95 });
		expect(held.skuId).toBeTypeOf('string');

		await db.update(sku).set({ buyPrice: 70 as never, buyPriceSource: 'pinned', buyPinnedSessionId: 'sess_counter_1', buyPinnedAt: now() }).where(eq(sku.id, held.skuId!));
		// A Pinned Buy Price is final: the Quantity Band does not apply.
		expect(await quotePrinting(db, { ...PIKACHU_NM, quantity: 4 })).toMatchObject({ buyPrice: 70, buyPriceAtOne: 70, buyPriceSource: 'pinned', sellPrice: 190, sellPriceSource: 'rule' });
	});

	it('answers with no price for a Printing the Catalogue has no Market Price for', async () => {
		expect(await quotePrinting(db, { printingId: 'prt-pokemon-base1-4', condition: 'NM', language: 'en' })).toMatchObject({ marketPrice: null, sellPrice: null, buyPrice: null });
	});

	it('names a Printing the Mirror does not hold as not found', async () => {
		await expect(quotePrinting(db, { printingId: 'prt-nowhere', condition: 'NM', language: 'en' })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
	});
});
