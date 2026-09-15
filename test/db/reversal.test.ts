import { env } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { ledgerEntry, ledgerLine, sku } from '../../server/db/schema';
import { recordAdjustment, reverseAdjustment } from '../../server/ledger/adjustment';
import { seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

const PIKACHU_NM = { printingId: 'prt-pokemon-base1-58', condition: 'NM', language: 'en' } as const;

async function onHand(condition: 'NM' | 'LP') {
	const rows = await db.select().from(sku).where(eq(sku.condition, condition));
	return rows[0]?.onHand;
}

async function linesOf(entryId: string) {
	return db.select().from(ledgerLine).where(eq(ledgerLine.entryId, entryId)).orderBy(asc(ledgerLine.quantity));
}

describe('a Reversal (ADR 0001)', () => {
	beforeEach(async () => {
		await seedPrinting(db);
	});

	it('appends a compensating entry with the opposite quantities, its own Reason and `reverses` set', async () => {
		await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 6 }, reason: 'found' }, STAFF_ACTOR);
		const original = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: -4 }, reason: 'damage' }, STAFF_ACTOR);

		const reversal = await reverseAdjustment(db, { entryId: original.entryId, reason: 'keying-error' }, STAFF_ACTOR);

		const [entry] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, reversal.entryId));
		expect(entry).toMatchObject({ kind: 'adjustment', reason: 'keying-error', reverses: original.entryId, note: null });
		expect(await linesOf(reversal.entryId)).toEqual([expect.objectContaining({ ...PIKACHU_NM, quantity: 4, cardName: 'Pikachu' })]);
		expect(await onHand('NM')).toBe(6);
		const [untouched] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, original.entryId));
		expect(untouched).toMatchObject({ reason: 'damage', reverses: null });
	});

	it('reverses a regrade as the opposite pair of lines', async () => {
		await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 3 }, reason: 'found' }, STAFF_ACTOR);
		const regrade = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 2 }, regradeTo: 'LP', reason: 'condition-regrade' }, STAFF_ACTOR);

		const reversal = await reverseAdjustment(db, { entryId: regrade.entryId, reason: 'wrong-card' }, STAFF_ACTOR);

		const lines = await linesOf(reversal.entryId);
		expect(lines.map(line => [line.condition, line.quantity])).toEqual([['LP', -2], ['NM', 2]]);
		expect(await onHand('NM')).toBe(3);
		expect(await onHand('LP')).toBe(0);
	});

	it('may reverse part of an entry', async () => {
		const original = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 4 }, reason: 'found' }, STAFF_ACTOR);
		const [line] = await linesOf(original.entryId);

		const reversal = await reverseAdjustment(db, { entryId: original.entryId, reason: 'keying-error', portion: [{ lineId: line!.id, copies: 1 }] }, STAFF_ACTOR);

		expect(await linesOf(reversal.entryId)).toEqual([expect.objectContaining({ quantity: -1 })]);
		expect(await onHand('NM')).toBe(3);
	});

	it('refuses a Reversal that would take on_hand below zero, leaving stock and the ledger untouched', async () => {
		const found = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 2 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: -2 }, reason: 'damage' }, STAFF_ACTOR);

		await expect(reverseAdjustment(db, { entryId: found.entryId, reason: 'keying-error' }, STAFF_ACTOR)).rejects.toMatchObject({
			data: { code: 'INSUFFICIENT_STOCK', details: { available: 0 } },
		});
		expect(await onHand('NM')).toBe(0);
		expect(await db.select().from(ledgerEntry)).toHaveLength(2);
	});

	it('requires a note with Reason `other`', async () => {
		const original = await recordAdjustment(db, { ...PIKACHU_NM, change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);

		await expect(reverseAdjustment(db, { entryId: original.entryId, reason: 'other' }, STAFF_ACTOR)).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		const reversal = await reverseAdjustment(db, { entryId: original.entryId, reason: 'other', note: 'Counted the wrong binder' }, STAFF_ACTOR);
		const [entry] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, reversal.entryId));
		expect(entry).toMatchObject({ reason: 'other', note: 'Counted the wrong binder' });
	});

	it('only reverses an Adjustment: an unknown entry is not found', async () => {
		await expect(reverseAdjustment(db, { entryId: 'nope', reason: 'keying-error' }, STAFF_ACTOR)).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
	});
});
