/**
 * The Adjustment write path (spec §3; §8.2, _Adjust modal_): a change to
 * stock that is not a Transaction, with a Reason and no POS Reference. One
 * entry of kind `adjustment`, one line for a count change, two balanced
 * lines for a regrade; `on_hand` never goes below zero.
 */
import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
import type { AdjustmentReason, ReversalReason } from '../../shared/domain/ledger';
import type { Db } from '../db/client';
import type { Actor } from './actor';
import type { EntryLine } from './commit';
import { and, eq, inArray } from 'drizzle-orm';
import { ledgerEntry, ledgerLine, sku } from '../db/schema';
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
	/** Moves the copies to another Condition instead: −n old, +n new, Reason `condition-regrade`. */
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

interface HeldSku {
	id: string;
	onHand: number;
}

async function findSku(db: Db, input: Pick<AdjustmentInput, 'printingId' | 'language'>, condition: Condition): Promise<HeldSku | undefined> {
	return db.query.sku.findFirst({
		columns: { id: true, onHand: true },
		where: and(eq(sku.storeId, STORE_ID), eq(sku.printingId, input.printingId), eq(sku.condition, condition), eq(sku.language, input.language)),
	});
}

/** The lines an Adjustment writes, given what the store holds now. */
function planLines(input: AdjustmentInput, held: HeldSku | undefined, target: HeldSku | undefined): EntryLine[] {
	const onHand = held?.onHand ?? 0;
	const base = { printingId: input.printingId, language: input.language };
	if (input.regradeTo !== undefined) {
		const moved = 'delta' in input.change ? input.change.delta : input.change.newCount;
		if (moved <= 0) {
			throw apiError('VALIDATION_FAILED', { message: 'A regrade moves at least one copy', details: { issues: [] } });
		}
		if (moved > onHand) {
			throw apiError('INSUFFICIENT_STOCK', { details: { available: onHand } });
		}
		return [
			{ ...base, id: newId(), skuId: held!.id, condition: input.condition, quantity: -moved, guard: { minOnHand: moved } },
			{ ...base, id: newId(), skuId: target?.id ?? newId(), condition: input.regradeTo, quantity: moved, guard: { minOnHand: 0 } },
		];
	}
	if ('newCount' in input.change) {
		return [{ ...base, id: newId(), skuId: held?.id ?? newId(), condition: input.condition, quantity: input.change.newCount - onHand, guard: { onHand } }];
	}
	const { delta } = input.change;
	if (delta < 0 && -delta > onHand) {
		throw apiError('INSUFFICIENT_STOCK', { details: { available: onHand } });
	}
	return [{ ...base, id: newId(), skuId: held?.id ?? newId(), condition: input.condition, quantity: delta, guard: { minOnHand: Math.max(0, -delta) } }];
}

/** Appends one Adjustment and moves `on_hand` in the same batch. */
export async function recordAdjustment(db: Db, input: AdjustmentInput, actor: Actor): Promise<AdjustmentResult> {
	const held = await findSku(db, input, input.condition);
	const target = input.regradeTo === undefined ? undefined : await findSku(db, input, input.regradeTo);
	const lines = planLines(input, held, target);
	const entryId = newId();
	const outcome = await commitEntry(db, {
		header: { id: entryId, kind: 'adjustment', createdAt: Date.now(), actor, reason: input.reason, note: input.note ?? null },
		lines,
	});
	if (!outcome.landed) {
		throw apiError('INSUFFICIENT_STOCK', { details: { available: held?.onHand ?? 0 }, message: 'Stock moved under this Adjustment; look again' });
	}
	const after = new Map<string, number>();
	for (const line of lines) {
		after.set(line.skuId, (after.get(line.skuId) ?? (line.skuId === held?.id ? held.onHand : line.skuId === target?.id ? target.onHand : 0)) + line.quantity);
	}
	return {
		entryId,
		lines: lines.map(line => ({
			skuId: line.skuId,
			printingId: line.printingId,
			condition: line.condition,
			language: line.language,
			quantity: line.quantity,
			onHand: after.get(line.skuId)!,
		})),
	};
}

export interface ReversalInput {
	/** The Adjustment being undone. */
	entryId: string;
	reason: ReversalReason;
	/** Required with Reason `other`. */
	note?: string | null;
	/** Which lines to reverse and how many copies of each; every line in full when absent (ADR 0001: a Reversal may cover part). */
	portion?: { lineId: string; copies: number }[];
}

/**
 * Undoes an Adjustment recorded wrongly: a new entry of the same kind with
 * the opposite quantities, its own Reversal Reason and `reverses` set.
 * Nothing recorded is edited or deleted.
 */
export async function reverseAdjustment(db: Db, input: ReversalInput, actor: Actor): Promise<AdjustmentResult> {
	if (input.reason === 'other' && !input.note?.trim()) {
		throw apiError('VALIDATION_FAILED', { message: 'Reason "other" needs a note', details: { issues: [] } });
	}
	const original = await db.query.ledgerEntry.findFirst({
		columns: { id: true, kind: true },
		where: and(eq(ledgerEntry.id, input.entryId), eq(ledgerEntry.storeId, STORE_ID), eq(ledgerEntry.kind, 'adjustment')),
	});
	if (!original) {
		throw apiError('NOT_FOUND', { message: 'No such Adjustment' });
	}
	const originalLines = await db.select().from(ledgerLine).where(eq(ledgerLine.entryId, original.id));
	const copiesByLine = new Map(input.portion?.map(({ lineId, copies }) => [lineId, copies]));
	const reversed = originalLines
		.map(line => ({ line, copies: input.portion ? (copiesByLine.get(line.id) ?? 0) : Math.abs(line.quantity) }))
		.filter(({ copies }) => copies > 0);
	if (reversed.length === 0 || reversed.some(({ line, copies }) => copies > Math.abs(line.quantity))) {
		throw apiError('VALIDATION_FAILED', { message: 'A Reversal covers copies the entry recorded', details: { issues: [] } });
	}
	const held = await db.select({ id: sku.id, onHand: sku.onHand }).from(sku).where(inArray(sku.id, reversed.map(({ line }) => line.skuId)));
	const onHandBySku = new Map(held.map(row => [row.id, row.onHand]));
	// A line reversing stock out needs the copies present, net of any other line of this Reversal on the same SKU.
	const outBySku = new Map<string, number>();
	const lines: EntryLine[] = reversed.map(({ line, copies }) => {
		const quantity = line.quantity > 0 ? -copies : copies;
		const out = (outBySku.get(line.skuId) ?? 0) + Math.max(0, -quantity);
		outBySku.set(line.skuId, out);
		return {
			id: newId(),
			skuId: line.skuId,
			printingId: line.printingId,
			condition: line.condition,
			language: line.language,
			quantity,
			guard: { minOnHand: out },
		};
	});
	for (const [skuId, out] of outBySku) {
		const available = onHandBySku.get(skuId) ?? 0;
		if (out > available) {
			throw apiError('INSUFFICIENT_STOCK', { details: { available } });
		}
	}
	const entryId = newId();
	const outcome = await commitEntry(db, {
		header: { id: entryId, kind: 'adjustment', createdAt: Date.now(), actor, reason: input.reason, note: input.note ?? null, reverses: original.id },
		lines,
	});
	if (!outcome.landed) {
		throw apiError('INSUFFICIENT_STOCK', { details: { available: 0 }, message: 'Stock moved under this Reversal; look again' });
	}
	const after = new Map(onHandBySku);
	for (const line of lines) {
		after.set(line.skuId, (after.get(line.skuId) ?? 0) + line.quantity);
	}
	return {
		entryId,
		lines: lines.map(line => ({ skuId: line.skuId, printingId: line.printingId, condition: line.condition, language: line.language, quantity: line.quantity, onHand: after.get(line.skuId)! })),
	};
}
