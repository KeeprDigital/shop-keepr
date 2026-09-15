/**
 * The Adjustment write path (spec §3; §8.2, _Adjust modal_): a change to
 * stock that is not a Transaction, with a Reason and no POS Reference. One
 * entry of kind `adjustment`, one line for a count change, two balanced
 * lines for a regrade; `on_hand` never goes below zero. A Reversal is the
 * same entry with the opposite quantities and `reverses` set (ADR 0001).
 */
import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
import type { AdjustmentReason, ReversalReason } from '../../shared/domain/ledger';
import type { Db } from '../db/client';
import type { Actor } from './actor';
import type { EntryHeader, EntryLine } from './commit';
import { and, eq, inArray } from 'drizzle-orm';
import { ledgerEntry, ledgerLine, printing, sku } from '../db/schema';
import { apiError } from '../utils/api-error';
import { newId } from '../utils/ids';
import { STORE_ID } from '../utils/store';
import { commitEntry } from './commit';

export interface AdjustmentInput {
	printingId: string;
	condition: Condition;
	language: Language;
	/** A quantity delta, or the new count the shelf actually shows: one of the two. */
	change: { delta: number } | { newCount: number };
	/** Moves `delta` copies to another Condition instead: −n old, +n new, Reason `condition-regrade`. */
	regradeTo?: Condition;
	reason: AdjustmentReason;
	note?: string | null;
}

export interface AdjustmentLineResult {
	skuId: string;
	printingId: string;
	condition: Condition;
	language: Language;
	quantity: number;
	/** The SKU's `on_hand` after the entry. */
	onHand: number;
}

export interface AdjustmentResult {
	entryId: string;
	lines: AdjustmentLineResult[];
}

/** A SKU row as it stood when the writer read it. */
interface SkuRow {
	id: string;
	onHand: number;
}

function invalid(message: string) {
	return apiError('VALIDATION_FAILED', { message, details: { issues: [] } });
}

async function findSku(db: Db, input: Pick<AdjustmentInput, 'printingId' | 'language'>, condition: Condition): Promise<SkuRow | undefined> {
	return db.query.sku.findFirst({
		columns: { id: true, onHand: true },
		where: and(eq(sku.storeId, STORE_ID), eq(sku.printingId, input.printingId), eq(sku.condition, condition), eq(sku.language, input.language)),
	});
}

/** The lines an Adjustment writes, given what the store holds now. */
function planLines(input: AdjustmentInput, current: SkuRow | undefined, target: SkuRow | undefined): EntryLine[] {
	const onHand = current?.onHand ?? 0;
	const base = { printingId: input.printingId, language: input.language };
	if (input.regradeTo !== undefined) {
		if (!('delta' in input.change) || input.change.delta <= 0) {
			throw invalid('A regrade moves at least one copy');
		}
		const moved = input.change.delta;
		if (moved > onHand) {
			throw apiError('INSUFFICIENT_STOCK', { details: { available: onHand } });
		}
		return [
			{ ...base, id: newId(), skuId: current!.id, condition: input.condition, quantity: -moved, guard: { minOnHand: moved } },
			{ ...base, id: newId(), skuId: target?.id ?? newId(), condition: input.regradeTo, quantity: moved, guard: { minOnHand: 0 } },
		];
	}
	if ('newCount' in input.change) {
		const delta = input.change.newCount - onHand;
		if (delta === 0) {
			throw invalid(`The count is already ${onHand}; nothing to record`);
		}
		return [{ ...base, id: newId(), skuId: current?.id ?? newId(), condition: input.condition, quantity: delta, guard: { onHand } }];
	}
	const { delta } = input.change;
	if (delta === 0) {
		throw invalid('A change moves at least one copy');
	}
	if (delta < 0 && -delta > onHand) {
		throw apiError('INSUFFICIENT_STOCK', { details: { available: onHand } });
	}
	return [{ ...base, id: newId(), skuId: current?.id ?? newId(), condition: input.condition, quantity: delta, guard: { minOnHand: Math.max(0, -delta) } }];
}

/** Runs the batch and reports each SKU's on-hand after it, from what was read plus what the lines moved. */
async function commitAdjustment(db: Db, header: Omit<EntryHeader, 'id' | 'kind' | 'createdAt'>, lines: EntryLine[], onHandBefore: ReadonlyMap<string, number>): Promise<AdjustmentResult> {
	const entryId = newId();
	const outcome = await commitEntry(db, { header: { ...header, id: entryId, kind: 'adjustment', createdAt: Date.now() }, lines });
	if (!outcome.landed) {
		// Stock moved between the read and the batch; the caller reads again.
		const stockOut = lines.filter(line => line.quantity < 0);
		const available = stockOut.length > 0 ? Math.min(...stockOut.map(line => onHandBefore.get(line.skuId) ?? 0)) : 0;
		throw apiError('INSUFFICIENT_STOCK', { details: { available }, message: 'Stock moved under this change; look again' });
	}
	const after = new Map(onHandBefore);
	for (const line of lines) {
		after.set(line.skuId, (after.get(line.skuId) ?? 0) + line.quantity);
	}
	return {
		entryId,
		lines: lines.map(({ skuId, printingId, condition, language, quantity }) => ({ skuId, printingId, condition, language, quantity, onHand: after.get(skuId)! })),
	};
}

/** Appends one Adjustment and moves `on_hand` in the same batch. */
export async function recordAdjustment(db: Db, input: AdjustmentInput, actor: Actor): Promise<AdjustmentResult> {
	const known = await db.query.printing.findFirst({ columns: { id: true }, where: eq(printing.id, input.printingId) });
	if (!known) {
		throw apiError('NOT_FOUND', { message: 'No such Printing in the Mirror' });
	}
	const current = await findSku(db, input, input.condition);
	const target = input.regradeTo === undefined ? undefined : await findSku(db, input, input.regradeTo);
	const lines = planLines(input, current, target);
	const onHandBefore = new Map([current, target].filter(row => row !== undefined).map(row => [row.id, row.onHand]));
	return commitAdjustment(db, { actor, reason: input.reason, note: input.note ?? null }, lines, onHandBefore);
}

export interface ReversalInput {
	/** The Adjustment being reversed. */
	entryId: string;
	reason: ReversalReason;
	/** Required with Reason `other`. */
	note?: string | null;
	/** Which lines to reverse and how many copies of each; every line's remainder when absent (ADR 0001: a Reversal may cover part). */
	portion?: { lineId: string; copies: number }[];
}

/**
 * Reverses an Adjustment recorded wrongly: a new entry of the same kind
 * with the opposite quantities, its own Reversal Reason and `reverses`
 * set. Nothing recorded is edited or deleted, and across every Reversal
 * of one entry no more is reversed than the entry recorded.
 */
export async function reverseAdjustment(db: Db, input: ReversalInput, actor: Actor): Promise<AdjustmentResult> {
	if (input.reason === 'other' && !input.note?.trim()) {
		throw invalid('Reason "other" needs a note');
	}
	const original = await db.query.ledgerEntry.findFirst({
		columns: { id: true },
		where: and(eq(ledgerEntry.id, input.entryId), eq(ledgerEntry.storeId, STORE_ID), eq(ledgerEntry.kind, 'adjustment')),
	});
	if (!original) {
		throw apiError('NOT_FOUND', { message: 'No such Adjustment' });
	}
	const originalLines = await db.select().from(ledgerLine).where(eq(ledgerLine.entryId, original.id));
	const remaining = await copiesLeftToReverse(db, original.id, originalLines);
	const lineById = new Map(originalLines.map(line => [line.id, line]));
	if (input.portion?.some(({ lineId }) => !lineById.has(lineId))) {
		throw invalid('A portion names a line of the entry being reversed');
	}
	const asked = input.portion
		? input.portion.map(({ lineId, copies }) => ({ line: lineById.get(lineId)!, copies }))
		: originalLines.map(line => ({ line, copies: remaining.get(line.id)! }));
	const reversed = asked.filter(({ copies }) => copies > 0);
	if (reversed.length === 0 || reversed.some(({ line, copies }) => copies > remaining.get(line.id)!)) {
		throw apiError('CONFLICT', { message: 'The entry has no such copies left to reverse' });
	}
	const skuRows = await db.select({ id: sku.id, onHand: sku.onHand }).from(sku).where(inArray(sku.id, reversed.map(({ line }) => line.skuId)));
	const onHandBefore = new Map(skuRows.map(row => [row.id, row.onHand]));
	// A line reversing stock out needs its copies present, net of this Reversal's other lines on the SKU.
	const stockOut = new Map<string, number>();
	const lines: EntryLine[] = reversed.map(({ line, copies }) => {
		const quantity = line.quantity > 0 ? -copies : copies;
		const out = (stockOut.get(line.skuId) ?? 0) + Math.max(0, -quantity);
		stockOut.set(line.skuId, out);
		return { id: newId(), skuId: line.skuId, printingId: line.printingId, condition: line.condition, language: line.language, quantity, guard: { minOnHand: out } };
	});
	for (const [skuId, out] of stockOut) {
		const available = onHandBefore.get(skuId) ?? 0;
		if (out > available) {
			throw apiError('INSUFFICIENT_STOCK', { details: { available } });
		}
	}
	return commitAdjustment(db, { actor, reason: input.reason, note: input.note ?? null, reverses: original.id }, lines, onHandBefore);
}

/** Per original line, the copies no earlier Reversal has taken back yet, matched by SKU. */
async function copiesLeftToReverse(db: Db, entryId: string, originalLines: (typeof ledgerLine.$inferSelect)[]): Promise<Map<string, number>> {
	const priorReversals = await db.select({ id: ledgerEntry.id }).from(ledgerEntry).where(eq(ledgerEntry.reverses, entryId));
	const takenBySku = new Map<string, number>();
	if (priorReversals.length > 0) {
		const priorLines = await db.select({ skuId: ledgerLine.skuId, quantity: ledgerLine.quantity }).from(ledgerLine).where(inArray(ledgerLine.entryId, priorReversals.map(row => row.id)));
		for (const line of priorLines) {
			takenBySku.set(line.skuId, (takenBySku.get(line.skuId) ?? 0) + Math.abs(line.quantity));
		}
	}
	const remaining = new Map<string, number>();
	for (const line of originalLines) {
		const taken = Math.min(Math.abs(line.quantity), takenBySku.get(line.skuId) ?? 0);
		takenBySku.set(line.skuId, (takenBySku.get(line.skuId) ?? 0) - taken);
		remaining.set(line.id, Math.abs(line.quantity) - taken);
	}
	return remaining;
}
