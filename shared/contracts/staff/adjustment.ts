/**
 * The Adjust modal's request (spec §8.2, _Adjust modal_): the SKU fixed
 * from the row, a delta or a new count, an optional regrade target, a
 * Reason from the modal's list, an optional note. The route validates
 * with this; the form keeps its own field-level schema and maps to it.
 * Language may be blank or any spelling: the route resolves it by the one
 * shared rule against the Store default (ADR 0002).
 */
import * as z from 'zod';
import { CONDITIONS } from '../../domain/condition';
import { ADJUST_MODAL_REASONS } from '../../domain/ledger';

const count = z.number().int().min(0).max(1_000_000);

export const zAdjustmentRequest = z.object({
	printingId: z.string().min(1),
	condition: z.enum(CONDITIONS),
	language: z.string().trim().max(16).optional(),
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
}).refine(input => input.regradeTo === undefined || ('delta' in input.change && input.change.delta > 0), {
	message: 'A regrade moves a number of copies, never sets a count',
	path: ['change'],
}).refine(input => (input.regradeTo === undefined) === (input.reason !== 'condition-regrade'), {
	message: 'A regrade carries Reason "condition-regrade", and only a regrade does',
	path: ['reason'],
});

export type AdjustmentRequest = z.output<typeof zAdjustmentRequest>;

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
