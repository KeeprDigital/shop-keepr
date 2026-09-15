/**
 * The ledger's closed lists (spec §3, _Enums_): codes are never renumbered
 * or reused because the ledger is permanent. Defined once here so the
 * schema, the ledger services and the staff UI share the one list. Reason
 * codes are kebab-case; the UI shows them in words.
 */
import { isOneOf } from './one-of';

/** Exactly three: a Trade is a Buy and a Sell, an Ingest is an Adjustment (ADR 0007, #35). */
export const LEDGER_KINDS = ['buy', 'sell', 'adjustment'] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Who wrote the row. The kiosk writes no ledger entry in the MVP, so every entry is `staff`. */
export const SURFACES = ['staff', 'kiosk'] as const;

export type Surface = (typeof SURFACES)[number];

/** What the Transaction was; distinct from `surface`. Never on an Adjustment. */
export const ORIGINS = ['kiosk', 'counter', 'list', 'large_buy'] as const;

export type Origin = (typeof ORIGINS)[number];

/** Two values only; no split Tender (ADR 0010). */
export const TENDERS = ['cash', 'credit'] as const;

export type Tender = (typeof TENDERS)[number];

/**
 * Why stock changed with no customer. Shrinkage is a Reason, not a kind;
 * `initial-load` and `found` are the Ingest session Reasons.
 */
export const ADJUSTMENT_REASONS = ['miscount', 'damage', 'shrinkage', 'found', 'condition-regrade', 'initial-load'] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export function isAdjustmentReason(value: unknown): value is AdjustmentReason {
	return isOneOf(ADJUSTMENT_REASONS, value);
}

/** On any entry carrying `reverses`; `other` requires a note. */
export const REVERSAL_REASONS = ['keying-error', 'customer-changed-mind', 'wrong-card', 'other'] as const;

export type ReversalReason = (typeof REVERSAL_REASONS)[number];

export function isReversalReason(value: unknown): value is ReversalReason {
	return isOneOf(REVERSAL_REASONS, value);
}

/** The Reason column holds either list: an Adjustment's, or a Reversal's when `reverses` is set. */
export const LEDGER_REASONS = [...ADJUSTMENT_REASONS, ...REVERSAL_REASONS] as const;

export type LedgerReason = (typeof LEDGER_REASONS)[number];

/** The Reasons the Adjust modal offers: `initial-load` belongs to the Ingest session (spec §8.2, _Adjust modal_). */
export const ADJUST_MODAL_REASONS = ADJUSTMENT_REASONS.filter(reason => reason !== 'initial-load');

/** How the UI shows a Reason (spec §3, _Enums_: the UI shows them in words). */
export const REASON_LABELS: Record<LedgerReason, string> = {
	'miscount': 'Miscount',
	'damage': 'Damage',
	'shrinkage': 'Shrinkage',
	'found': 'Found',
	'condition-regrade': 'Condition regrade',
	'initial-load': 'Initial load',
	'keying-error': 'Keying error',
	'customer-changed-mind': 'Customer changed mind',
	'wrong-card': 'Wrong card',
	'other': 'Other',
};
