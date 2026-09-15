import type { AdjustmentInput } from '../../server/ledger/adjustment';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { ledgerEntry, ledgerLine, sku } from '../../server/db/schema';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { STORE_ID } from '../../server/utils/store';
import { linesOf as linesOfIn, PIKACHU_NM, seedPrinting, STAFF_ACTOR } from '../support/stock';

const db = createDb(env.DB);

async function skuRow(printingId: string, condition: string, language = 'en') {
	const rows = await db.select().from(sku).where(eq(sku.printingId, printingId));
	return rows.find(row => row.condition === condition && row.language === language);
}

const linesOf = (entryId: string) => linesOfIn(db, entryId);

function adjust(input: Partial<AdjustmentInput> & Pick<AdjustmentInput, 'change' | 'reason'>) {
	return recordAdjustment(db, { ...PIKACHU_NM, ...input }, STAFF_ACTOR);
}

async function ledgerCounts() {
	const [entries, lines] = await Promise.all([db.select().from(ledgerEntry), db.select().from(ledgerLine)]);
	return { entries: entries.length, lines: lines.length };
}

describe('an Adjustment (spec §3, ADR 0001)', () => {
	beforeEach(async () => {
		await seedPrinting(db);
	});

	it('appends a header and a line for cards found, and moves on_hand from nothing to three', async () => {
		const result = await recordAdjustment(db, {
			printingId: 'prt-pokemon-base1-58',
			condition: 'NM',
			language: 'en',
			change: { delta: 3 },
			reason: 'found',
		}, STAFF_ACTOR);

		const [entry] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, result.entryId));
		expect(entry).toMatchObject({
			storeId: STORE_ID,
			kind: 'adjustment',
			surface: 'staff',
			sessionId: 'sess_counter_1',
			staffUserId: null,
			reason: 'found',
			origin: null,
			posReference: null,
			total: null,
			net: null,
			reverses: null,
		});
		expect(entry!.createdAt).toBeGreaterThan(1_700_000_000_000);

		const lines = await linesOf(result.entryId);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			storeId: STORE_ID,
			printingId: 'prt-pokemon-base1-58',
			condition: 'NM',
			language: 'en',
			quantity: 3,
			cardName: 'Pikachu',
			collectorNumber: '58',
			setCode: 'base1',
			rarity: 'common',
			listPrice: null,
			transactedPrice: null,
		});

		const held = await skuRow('prt-pokemon-base1-58', 'NM');
		expect(held).toMatchObject({ storeId: STORE_ID, onHand: 3 });
		expect(lines[0]!.skuId).toBe(held!.id);
		expect(result.lines).toEqual([expect.objectContaining({ skuId: held!.id, quantity: 3, onHand: 3 })]);
	});

	it.each([
		['miscount', -1, 3],
		['damage', -2, 2],
		['shrinkage', -4, 0],
	] as const)('records %s as a negative line and moves on_hand by it', async (reason, delta, expectedOnHand) => {
		await adjust({ change: { delta: 4 }, reason: 'found' });

		const result = await adjust({ change: { delta }, reason });

		const [entry] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, result.entryId));
		expect(entry).toMatchObject({ kind: 'adjustment', reason });
		expect(await linesOf(result.entryId)).toEqual([expect.objectContaining({ quantity: delta, cardName: 'Pikachu' })]);
		expect((await skuRow(PIKACHU_NM.printingId, 'NM'))?.onHand).toBe(expectedOnHand);
	});

	it('refuses a change that would take on_hand below zero and writes nothing', async () => {
		await adjust({ change: { delta: 3 }, reason: 'found' });
		const before = await ledgerCounts();

		await expect(adjust({ change: { delta: -5 }, reason: 'shrinkage' })).rejects.toMatchObject({
			statusCode: 409,
			data: { code: 'INSUFFICIENT_STOCK', details: { available: 3 } },
		});

		expect(await ledgerCounts()).toEqual(before);
		expect((await skuRow(PIKACHU_NM.printingId, 'NM'))?.onHand).toBe(3);
	});

	it('refuses to take a never-held SKU negative without creating its row', async () => {
		await expect(adjust({ change: { delta: -1 }, reason: 'miscount' })).rejects.toMatchObject({ data: { code: 'INSUFFICIENT_STOCK' } });

		expect(await skuRow(PIKACHU_NM.printingId, 'NM')).toBeUndefined();
	});

	it('takes a new count and writes the difference as the line', async () => {
		await adjust({ change: { delta: 5 }, reason: 'initial-load' });

		const result = await adjust({ change: { newCount: 2 }, reason: 'miscount' });

		expect(await linesOf(result.entryId)).toEqual([expect.objectContaining({ quantity: -3 })]);
		expect((await skuRow(PIKACHU_NM.printingId, 'NM'))?.onHand).toBe(2);
		expect(result.lines[0]).toMatchObject({ quantity: -3, onHand: 2 });
	});

	it('writes a regrade as two balanced lines in one entry: −n old, +n new', async () => {
		await adjust({ change: { delta: 4 }, reason: 'found' });

		const result = await adjust({ change: { delta: 3 }, regradeTo: 'LP', reason: 'condition-regrade' });

		const [entry] = await db.select().from(ledgerEntry).where(eq(ledgerEntry.id, result.entryId));
		expect(entry).toMatchObject({ kind: 'adjustment', reason: 'condition-regrade' });
		const lines = await linesOf(result.entryId);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ condition: 'NM', language: 'en', quantity: -3, cardName: 'Pikachu', setCode: 'base1' });
		expect(lines[1]).toMatchObject({ condition: 'LP', language: 'en', quantity: 3, cardName: 'Pikachu', setCode: 'base1' });
		expect((await skuRow(PIKACHU_NM.printingId, 'NM'))?.onHand).toBe(1);
		expect((await skuRow(PIKACHU_NM.printingId, 'LP'))?.onHand).toBe(3);
		expect(lines.map(line => line.skuId)).toEqual(result.lines.map(line => line.skuId));
	});

	it('refuses a regrade of more copies than are held', async () => {
		await adjust({ change: { delta: 1 }, reason: 'found' });

		await expect(adjust({ change: { delta: 2 }, regradeTo: 'LP', reason: 'condition-regrade' })).rejects.toMatchObject({
			data: { code: 'INSUFFICIENT_STOCK', details: { available: 1 } },
		});
		expect(await skuRow(PIKACHU_NM.printingId, 'LP')).toBeUndefined();
	});

	it('keeps a Japanese copy as its own SKU beside the English one', async () => {
		await adjust({ change: { delta: 2 }, reason: 'found' });
		await adjust({ change: { delta: 1 }, reason: 'found', language: 'ja' });

		expect((await skuRow(PIKACHU_NM.printingId, 'NM', 'en'))?.onHand).toBe(2);
		expect((await skuRow(PIKACHU_NM.printingId, 'NM', 'ja'))?.onHand).toBe(1);
	});

	it('refuses a new count that changes nothing, so no zero-quantity line is ever written', async () => {
		await adjust({ change: { delta: 2 }, reason: 'found' });
		const before = await ledgerCounts();

		await expect(adjust({ change: { newCount: 2 }, reason: 'miscount' })).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
		await expect(adjust({ change: { newCount: 0 }, reason: 'miscount', condition: 'LP' })).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });

		expect(await ledgerCounts()).toEqual(before);
		expect(await skuRow(PIKACHU_NM.printingId, 'LP')).toBeUndefined();
	});

	it('refuses a regrade given as a new count: a regrade moves copies', async () => {
		await adjust({ change: { delta: 2 }, reason: 'found' });

		await expect(adjust({ change: { newCount: 1 }, regradeTo: 'LP', reason: 'condition-regrade' })).rejects.toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
	});

	it('names a Printing the Mirror does not hold as not found', async () => {
		await expect(adjust({ printingId: 'prt-nowhere', change: { delta: 1 }, reason: 'found' })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
	});
});
