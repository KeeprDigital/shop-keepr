/**
 * The Adjust modal's request (spec §8.2, _Adjust modal_): the SKU fixed
 * from the row, a delta or a new count, an optional regrade target, a
 * Reason from the modal's list, an optional note. Validated by the route
 * and by the form with the one schema.
 */
import * as z from 'zod';
import { CONDITIONS } from '../../domain/condition';
import { LANGUAGES } from '../../domain/language';
import { ADJUST_MODAL_REASONS, REVERSAL_REASONS } from '../../domain/ledger';

const count = z.number().int().min(0).max(1_000_000);

export const zAdjustmentRequest = z.object({
	printingId: z.string().min(1),
	condition: z.enum(CONDITIONS),
	language: z.enum(LANGUAGES),
	change: z.union([
		z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000).refine(value => value !== 0, 'A change moves at least one copy') }),
		z.object({ newCount: count }),
	]),
	regradeTo: z.enum(CONDITIONS).optional(),
	reason: z.enum(ADJUST_MODAL_REASONS),
	note: z.string().trim().max(500).optional(),
}).refine(input => input.regradeTo === undefined || input.regradeTo !== input.condition, {
	message: 'A regrade moves copies to a different Condition',
	path: ['regradeTo'],
}).refine(input => (input.regradeTo === undefined) === (input.reason !== 'condition-regrade'), {
	message: 'A regrade carries Reason "condition-regrade", and only a regrade does',
	path: ['reason'],
});

export type AdjustmentRequest = z.output<typeof zAdjustmentRequest>;

export const zReversalRequest = z.object({
	reason: z.enum(REVERSAL_REASONS),
	note: z.string().trim().max(500).optional(),
	portion: z.array(z.object({ lineId: z.string().min(1), copies: z.number().int().min(1) })).min(1).optional(),
}).refine(input => input.reason !== 'other' || Boolean(input.note), {
	message: 'Reason "other" needs a note',
	path: ['note'],
});

export type ReversalRequest = z.output<typeof zReversalRequest>;

export interface AdjustmentResponse {
	entryId: string;
	lines: {
		skuId: string;
		printingId: string;
		condition: string;
		language: string;
		quantity: number;
		onHand: number;
	}[];
}
