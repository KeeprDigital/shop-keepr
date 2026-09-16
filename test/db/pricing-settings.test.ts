import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { readPricingSettings, writePricingSetting } from '../../server/pricing/settings';
import { readRepriceProgress } from '../../server/pricing/sweep';
import { SEEDED_STORE_SETTINGS } from '../../shared/pricing/settings';
import { memoryQueue } from '../support/reprice';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

let tick = 1_900_000_000_000;
function write(scope: string, ref: Parameters<typeof writePricingSetting>[1]['ref'], value: unknown, queue = memoryQueue()) {
	return writePricingSetting(db, { scope, ref, value }, { queue, now: (tick += 1_000) });
}

describe('the Pricing Rules in D1 (spec §6, _Store settings_: seeded, per setting, per scope)', () => {
	it('starts every Store default at the seed, with no Game System rules', async () => {
		const settings = await readPricingSettings(db);
		expect(settings.store).toEqual(SEEDED_STORE_SETTINGS);
		expect(settings.store.buy.tender).toEqual({ def: 'cash', mod: 0 });
		expect(settings.store.buy.stockBands).toEqual([{ from: 0, k: 1, f: 0 }]);
		expect(settings.store.buy.qtyBands).toEqual([{ from: 1, k: 1, f: 0 }]);
		expect(settings.games).toEqual({});
	});

	it('holds a Game System override beside the Store default, and reverts it on a null write', async () => {
		await write('magic', { side: 'buy', key: 'floor' }, 10);
		expect((await readPricingSettings(db)).games.magic).toEqual({ sell: {}, buy: { floor: 10 }, rows: [] });
		expect((await readPricingSettings(db)).store.buy.floor).toBe(5);

		await write('magic', { side: 'buy', key: 'floor' }, null);
		expect((await readPricingSettings(db)).games.magic).toBeUndefined();
	});

	it('replaces a Store default in place', async () => {
		await write('store', { side: 'sell', key: 'rounding' }, { inc: 5, dir: 'nearest' });
		expect((await readPricingSettings(db)).store.sell.rounding).toEqual({ inc: 5, dir: 'nearest' });
	});

	it('keeps a Game System\'s attribute rows as one list on both sides', async () => {
		const rows = [{ attr: 'rarity', value: 'mythic', sell: { k: 1, f: 100, floor: 100 }, buy: { k: 1, f: 0, floor: 50 } }];
		await write('magic', { side: 'rows', key: 'rows' }, rows);
		expect((await readPricingSettings(db)).games.magic?.rows).toEqual(rows);
		await write('magic', { side: 'rows', key: 'rows' }, []);
		expect((await readPricingSettings(db)).games.magic).toBeUndefined();
	});

	it('refuses a value the evaluator could not fold, and a revert of a Store default', async () => {
		await expect(write('store', { side: 'sell', key: 'rounding' }, { inc: 0, dir: 'up' })).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(write('store', { side: 'sell', key: 'steps' }, ['condition', 'fx'])).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(write('store', { side: 'sell', key: 'steps' }, ['fx', 'stock'])).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(write('store', { side: 'buy', key: 'floor' }, null)).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(write('magic', { side: 'buy', key: 'tender' }, { def: 'credit', mod: 10 })).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(write('store', { side: 'rows', key: 'rows' }, [])).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		// Attribute rows key only on the game's Pricing Attribute registry: Pokémon prices by rarity and variant, not finish.
		await expect(write('pokemon', { side: 'rows', key: 'rows' }, [{ attr: 'finish', value: 'holo', sell: { k: 1, f: 0, floor: null }, buy: { k: 1, f: 0, floor: null } }])).rejects.toMatchObject({ statusCode: 400 });
		await expect(write('lorcana', { side: 'sell', key: 'floor' }, 10)).rejects.toMatchObject({ statusCode: 400 });
		expect((await readPricingSettings(db)).store).toEqual(SEEDED_STORE_SETTINGS);
	});
});

describe('a setting edit and the sweep (spec §6: one queue-backed job per Store)', () => {
	beforeEach(async () => {
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD' });
		await seedPrinting(db, { id: 'prt-magic-lea-232', cardId: 'card-magic-black-lotus', gameSystem: 'magic', name: 'Black Lotus', setCode: 'lea', collectorNumber: '232', rarity: 'rare', marketPrice: 1_000_000, marketPriceCurrency: 'USD' });
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-58', condition: 'NM', language: 'en', change: { delta: 4 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-pokemon-base1-58', condition: 'LP', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-magic-lea-232', condition: 'MP', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
	});

	it('enqueues one sweep, scoped to the games the setting reaches, with the SKU count the confirm names', async () => {
		const queue = memoryQueue();
		const outcome = await write('pokemon', { side: 'buy', key: 'floor' }, 10, queue);
		expect(outcome.sweep).toEqual({ games: ['pokemon'], skus: 2 });
		expect(outcome.sweepId).toBeTypeOf('string');
		expect(queue.sent).toEqual([{ sweepId: outcome.sweepId }]);
		expect(await readRepriceProgress(db)).toMatchObject({ id: outcome.sweepId, status: 'queued', reason: 'settings', games: ['pokemon'], total: 2, done: 0 });
	});

	it('reaches every game that inherits a Store default, and folds a second edit into the job already queued', async () => {
		const queue = memoryQueue();
		await write('magic', { side: 'sell', key: 'floor' }, 50, queue);
		const first = await write('store', { side: 'sell', key: 'floor' }, 30, queue);
		expect(first.sweep).toEqual({ games: ['pokemon', 'onepiece', 'riftbound'], skus: 2 });
		const second = await write('store', { side: 'sell', key: 'condition' }, SEEDED_STORE_SETTINGS.sell.condition, queue);
		expect(second.sweep).toEqual({ games: ['magic', 'pokemon', 'onepiece', 'riftbound'], skus: 3 });
		expect(second.sweepId).toBe(first.sweepId);
		expect(queue.sent).toHaveLength(1);
		expect(await readRepriceProgress(db)).toMatchObject({ id: first.sweepId, status: 'queued', games: ['magic', 'pokemon', 'onepiece', 'riftbound'], total: 3 });
	});

	it('never sweeps for Tender', async () => {
		const queue = memoryQueue();
		const outcome = await write('store', { side: 'buy', key: 'tender' }, { def: 'credit', mod: 25 }, queue);
		expect(outcome.sweep).toEqual({ games: [], skus: 0 });
		expect(outcome.sweepId).toBeNull();
		expect(queue.sent).toEqual([]);
		expect(await readRepriceProgress(db)).toBeNull();
		expect((await readPricingSettings(db)).store.buy.tender).toEqual({ def: 'credit', mod: 25 });
	});
});
