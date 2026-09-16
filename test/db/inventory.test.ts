import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { sku } from '../../server/db/schema';
import { setExchangeRateManually } from '../../server/fx/exchange-rate';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { listInventory } from '../../server/ledger/inventory';
import { memoryQueue } from '../support/reprice';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

describe('inventory (spec §8.2, `/inventory`)', () => {
	beforeEach(async () => {
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await seedPrinting(db, { id: 'prt-pokemon-base1-4', cardId: 'card-pokemon-charizard', name: 'Charizard', collectorNumber: '4', rarity: 'rare_holo', finish: 'holo', marketPrice: 41_000, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await seedPrinting(db, { id: 'prt-magic-lea-232', cardId: 'card-magic-black-lotus', gameSystem: 'magic', name: 'Black Lotus', setCode: 'lea', collectorNumber: '232', rarity: 'rare', withdrawn: true, marketPrice: 1_000_000, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await seedPrinting(db, { id: 'prt-magic-unf-100', cardId: 'card-magic-hundred', gameSystem: 'magic', name: '100% Chance of Rain', setCode: 'unf', collectorNumber: '100_a', rarity: 'common' });
		await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.79, sessionId: 'sess_counter_1', queue: memoryQueue(), now: 1_900_000_000_000 });
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-58', condition: 'NM', language: 'en', change: { delta: 4 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-58', condition: 'LP', language: 'ja', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-4', condition: 'NM', language: 'en', change: { delta: 2 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-magic-lea-232', condition: 'MP', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-magic-unf-100', condition: 'NM', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
		// Sold out: the row stays at 0 and leaves the list.
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-4', condition: 'HP', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-4', condition: 'HP', language: 'en', change: { delta: -1 }, reason: 'shrinkage' }, STAFF_ACTOR);
	});

	it('lists every SKU with stock on hand, with its Printing, Condition, Language, on-hand and withdrawn flag', async () => {
		const { rows, games } = await listInventory(db, {});

		expect(games).toEqual(['magic', 'pokemon']);
		expect(rows.map(row => [row.name, row.condition, row.language, row.onHand, row.withdrawn])).toEqual([
			['100% Chance of Rain', 'NM', 'en', 1, false],
			['Black Lotus', 'MP', 'en', 1, true],
			['Charizard', 'NM', 'en', 2, false],
			['Pikachu', 'NM', 'en', 4, false],
			['Pikachu', 'LP', 'ja', 1, false],
		]);
		expect(rows[2]).toMatchObject({ printingId: 'prt-pokemon-base1-4', gameSystem: 'pokemon', setCode: 'base1', collectorNumber: '4', finish: 'holo' });
		expect(rows[2]!.skuId).toBeTypeOf('string');
	});

	it('carries each row\'s stored Sell and Buy Price, its Market Price and when it was priced, in the Store\'s currency', async () => {
		const { rows, currency } = await listInventory(db, {});
		expect(currency).toBe('GBP');
		// $410 at 0.79 is £323.90: Sell 110 %, rounded up to 10p; Buy 65 %, rounded down to 5p.
		expect(rows[2]).toMatchObject({ name: 'Charizard', marketPrice: 41_000, marketPriceCurrency: 'USD', sellPrice: 35_630, buyPrice: 21_050, sellPriceSource: 'rule', buyPriceSource: 'rule' });
		expect(rows[2]!.pricedAt).toBeGreaterThan(0);
		// No Market Price: evaluated, nothing to say.
		expect(rows[0]).toMatchObject({ name: '100% Chance of Rain', marketPrice: null, sellPrice: null, buyPrice: null });
	});

	it('sorts by Sell Price and Buy Price from the stored columns, nulls last', async () => {
		expect((await listInventory(db, { sort: 'sellPrice', direction: 'asc' })).rows.map(row => row.sellPrice)).toEqual([150, 190, 35_630, 608_300, null]);
		expect((await listInventory(db, { sort: 'buyPrice', direction: 'desc' })).rows.map(row => row.buyPrice)).toEqual([308_100, 21_050, 95, 60, null]);
		expect((await listInventory(db, { sort: 'marketPrice', direction: 'desc' })).rows.map(row => row.name)).toEqual(['Black Lotus', 'Charizard', 'Pikachu', 'Pikachu', '100% Chance of Rain']);
	});

	it('lists a pinned SKU at on-hand 0 beside the stock on hand', async () => {
		const [sold] = await db.select({ id: sku.id }).from(sku).where(eq(sku.condition, 'HP'));
		await db.update(sku).set({ sellPrice: 12_345 as never, sellPriceSource: 'pinned', sellPinnedSessionId: 'sess_counter_1', sellPinnedAt: 1_900_000_000_000 }).where(eq(sku.id, sold!.id));
		const { rows } = await listInventory(db, { q: 'chariz' });
		expect(rows.map(row => [row.condition, row.onHand, row.sellPrice, row.sellPriceSource])).toEqual([['NM', 2, 35_630, 'rule'], ['HP', 0, 12_345, 'pinned']]);
	});

	it('filters by Game System and by name', async () => {
		expect((await listInventory(db, { game: 'magic' })).rows.map(row => row.name)).toEqual(['100% Chance of Rain', 'Black Lotus']);
		expect((await listInventory(db, { q: 'pika' })).rows.map(row => row.name)).toEqual(['Pikachu', 'Pikachu']);
		expect((await listInventory(db, { game: 'pokemon', q: 'lotus' })).rows).toEqual([]);
	});

	it('takes LIKE wildcards in a search as the characters typed', async () => {
		expect((await listInventory(db, { q: '100%' })).rows.map(row => row.name)).toEqual(['100% Chance of Rain']);
		expect((await listInventory(db, { q: '%' })).rows.map(row => row.name)).toEqual(['100% Chance of Rain']);
		expect((await listInventory(db, { q: '_' })).rows).toEqual([]);
	});

	it('sorts by any column, in either direction', async () => {
		expect((await listInventory(db, { sort: 'onHand', direction: 'desc' })).rows.map(row => row.onHand)).toEqual([4, 2, 1, 1, 1]);
		expect((await listInventory(db, { sort: 'condition', direction: 'asc' })).rows.map(row => row.condition)).toEqual(['NM', 'NM', 'NM', 'LP', 'MP']);
		expect((await listInventory(db, { sort: 'language', direction: 'desc' })).rows.map(row => row.language)).toEqual(['ja', 'en', 'en', 'en', 'en']);
	});
});
