import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { ledgerEntry, ledgerLine, sku } from '../../server/db/schema';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { commitStatements } from '../../server/ledger/commit';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

const PIKACHU_NM = { printingId: 'prt-pokemon-base1-58', condition: 'NM', language: 'en' } as const;

/**
 * `batch()` is atomic but not conditional (spec §4.1; ADR 0011): a
 * statement whose predecessor changed nothing still runs. So each
 * dependent statement is run here with its predecessor missing or failed,
 * and must change nothing on its own.
 */
describe('the commit batch guards', () => {
	beforeEach(async () => {
		await seedPrinting(db);
		await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 3 }, reason: 'found' }, STAFF_ACTOR);
	});

	async function heldSku() {
		const [row] = await db.select().from(sku);
		return row!;
	}

	function planFor(skuId: string, quantity: number, guard: { minOnHand: number } | { onHand: number }) {
		return commitStatements(db, {
			header: { id: 'entry_guard', kind: 'adjustment', createdAt: Date.now(), actor: STAFF_ACTOR, reason: 'miscount' },
			lines: [{ id: 'line_guard', skuId, ...PIKACHU_NM, quantity, guard }],
		});
	}

	it('the header does not land when a line\'s stock condition fails, so nothing depending on it lands either', async () => {
		const held = await heldSku();
		const { skuUpserts, headerInsert, lineInserts, onHandUpdates } = planFor(held.id, -5, { minOnHand: 5 });

		const results = await db.$client.batch([...skuUpserts, headerInsert, ...lineInserts, ...onHandUpdates]);

		expect(results.map(result => result.meta.changes)).toEqual([0, 0, 0, 0]);
		expect((await heldSku()).onHand).toBe(3);
		expect(await db.select().from(ledgerEntry)).toHaveLength(1);
	});

	it('a line does not land without its header', async () => {
		const held = await heldSku();
		const { lineInserts, onHandUpdates } = planFor(held.id, -1, { minOnHand: 1 });

		const results = await db.$client.batch([...lineInserts, ...onHandUpdates]);

		expect(results.map(result => result.meta.changes)).toEqual([0, 0]);
		expect(await db.select().from(ledgerLine)).toHaveLength(1);
		expect((await heldSku()).onHand).toBe(3);
	});

	it('an on_hand update does not apply without its line', async () => {
		const held = await heldSku();
		const { onHandUpdates } = planFor(held.id, -1, { minOnHand: 1 });

		const [result] = await db.$client.batch(onHandUpdates);

		expect(result!.meta.changes).toBe(0);
		expect((await heldSku()).onHand).toBe(3);
	});

	it('a count guard holds the entry to the on_hand the writer read', async () => {
		const held = await heldSku();
		const { skuUpserts, headerInsert, lineInserts, onHandUpdates } = planFor(held.id, -1, { onHand: 2 });

		const results = await db.$client.batch([...skuUpserts, headerInsert, ...lineInserts, ...onHandUpdates]);

		expect(results[1]!.meta.changes).toBe(0);
		expect((await heldSku()).onHand).toBe(3);
	});
});
