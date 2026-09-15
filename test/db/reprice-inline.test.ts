import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { sku } from '../../server/db/schema';
import { setExchangeRateManually } from '../../server/fx/exchange-rate';
import { recordAdjustment, reverseAdjustment } from '../../server/ledger/adjustment';
import { writePricingSetting } from '../../server/pricing/settings';
import { memoryQueue } from '../support/reprice';
import { PIKACHU_NM, seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

let tick = 1_900_000_000_000;
const now = () => (tick += 1_000);

async function row(condition = 'NM') {
	const rows = await db.select().from(sku).where(eq(sku.printingId, PIKACHU_NM.printingId));
	return rows.find(r => r.condition === condition)!;
}

function adjust(delta: number, condition: 'NM' | 'LP' = 'NM') {
	return recordAdjustment(db, { ...PIKACHU_NM, condition, change: { delta }, reason: delta > 0 ? 'found' : 'shrinkage' }, STAFF_ACTOR);
}

describe('the inline recompute (spec §6: every ledger append recomputes that SKU\'s Buy Price in the request)', () => {
	beforeEach(async () => {
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD', marketPriceUpdatedAt: 1_789_084_800_000 });
		await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.79, sessionId: 'sess_counter_1', queue: memoryQueue(), now: now() });
		// Stock Bands that pay less the more the store holds; the seed's are neutral.
		await writePricingSetting(db, { scope: 'store', ref: { side: 'buy', key: 'stockBands' }, value: [{ from: 0, k: 1, f: 0 }, { from: 4, k: 0.5, f: 0 }] }, { queue: memoryQueue(), now: now() });
	});

	it('gives a never-held card both prices at its first entry, and moves the Buy Price with on-hand from then on', async () => {
		await adjust(3);
		expect(await row()).toMatchObject({ onHand: 3, sellPrice: 190, buyPrice: 95, sellPriceSource: 'rule', buyPriceSource: 'rule' });
		expect((await row()).pricedAt).toBeGreaterThan(0);

		await adjust(1);
		expect(await row()).toMatchObject({ onHand: 4, sellPrice: 190, buyPrice: 45 });

		await adjust(-2);
		expect(await row()).toMatchObject({ onHand: 2, buyPrice: 95 });
	});

	it('recomputes each SKU a regrade or a Reversal touches', async () => {
		await adjust(5);
		const regrade = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 2 }, regradeTo: 'LP', reason: 'condition-regrade' }, STAFF_ACTOR);
		expect(await row('NM')).toMatchObject({ onHand: 3, buyPrice: 95 });
		expect(await row('LP')).toMatchObject({ onHand: 2, sellPrice: 170, buyPrice: 75 });

		await reverseAdjustment(db, { entryId: regrade.entryId, reason: 'keying-error' }, STAFF_ACTOR);
		expect(await row('NM')).toMatchObject({ onHand: 5, buyPrice: 45 });
		expect(await row('LP')).toMatchObject({ onHand: 0, buyPrice: 75 });
	});

	it('leaves a pinned Buy Price alone and does not touch the Sell Price of a row already priced', async () => {
		await adjust(1);
		await db.update(sku).set({ buyPrice: 77 as never, buyPriceSource: 'pinned', buyPinnedSessionId: 'sess_counter_1', buyPinnedAt: now(), sellPrice: 999 as never }).where(eq(sku.id, (await row()).id));

		await adjust(3);
		expect(await row()).toMatchObject({ onHand: 4, buyPrice: 77, sellPrice: 999 });
	});
});
