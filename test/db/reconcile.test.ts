import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { projectionDrift, sku } from '../../server/db/schema';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { reconcileOnHand } from '../../server/ledger/reconcile';
import { STORE_ID } from '../../server/utils/store';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

const PIKACHU = { printingId: 'prt-pokemon-base1-58', language: 'en' } as const;

describe('the reconcile job (spec §3, _Reconcile job and projection_drift_)', () => {
	beforeEach(async () => {
		await seedPrinting(db);
		await recordAdjustment(db, { ...PIKACHU, condition: 'NM', change: { delta: 5 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { ...PIKACHU, condition: 'NM', change: { delta: -2 }, reason: 'damage' }, STAFF_ACTOR);
		await recordAdjustment(db, { ...PIKACHU, condition: 'LP', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);
	});

	it('heals every drifted SKU in one run', async () => {
		await db.update(sku).set({ onHand: 0 });

		const outcome = await reconcileOnHand(db);

		expect(outcome.healed.map(heal => heal.ledgerOnHand).sort()).toEqual([1, 3]);
		expect((await db.select().from(sku)).map(row => row.onHand).sort()).toEqual([1, 3]);
		expect(await db.select().from(projectionDrift)).toHaveLength(2);
	});

	it('writes nothing on a clean run', async () => {
		const outcome = await reconcileOnHand(db);

		expect(outcome).toEqual({ checked: 2, healed: [] });
		expect(await db.select().from(projectionDrift)).toHaveLength(0);
	});

	it('heals a hand-corrupted on_hand from the ledger sum and records the heal once', async () => {
		const [nm] = await db.select().from(sku).where(eq(sku.condition, 'NM'));
		await db.update(sku).set({ onHand: 9 }).where(eq(sku.id, nm!.id));

		const outcome = await reconcileOnHand(db);

		expect(outcome.healed).toEqual([{ skuId: nm!.id, storedOnHand: 9, ledgerOnHand: 3 }]);
		const [healed] = await db.select().from(sku).where(eq(sku.id, nm!.id));
		expect(healed!.onHand).toBe(3);
		const drift = await db.select().from(projectionDrift);
		expect(drift).toEqual([expect.objectContaining({ storeId: STORE_ID, skuId: nm!.id, storedOnHand: 9, ledgerOnHand: 3 })]);
		expect(drift[0]!.healedAt).toBeGreaterThan(1_700_000_000_000);

		expect((await reconcileOnHand(db)).healed).toEqual([]);
		expect(await db.select().from(projectionDrift)).toHaveLength(1);
	});
});
