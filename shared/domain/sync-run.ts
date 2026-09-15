/**
 * The Catalogue sync run: what the Mirror is filled, refreshed and healed by
 * (ADR 0009; spec §5, _Sync: one cursor walk_). Two kinds, each with its own
 * cursor per Game System and its own cadence, and the statuses the System
 * page and the staff banner read. Defined once here so the schema, the sync
 * module and the staff UI share the one list.
 */
import { isOneOf } from './one-of';

export const SYNC_KINDS = ['catalogue', 'market_price'] as const;

export type SyncKind = (typeof SYNC_KINDS)[number];

export function isSyncKind(value: unknown): value is SyncKind {
	return isOneOf(SYNC_KINDS, value);
}

/**
 * `running` is also the lock: one per kind. A run that quarantined a record
 * or found a full walk disagreeing with the Mirror finishes
 * `completed_with_drift`; a run whose page could not be applied after its
 * retries is `failed`; a `running` row left behind past the staleness window
 * is `abandoned` by the next claim.
 */
export const SYNC_RUN_STATUSES = ['running', 'completed', 'completed_with_drift', 'failed', 'abandoned'] as const;

export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export function isSyncRunStatus(value: unknown): value is SyncRunStatus {
	return isOneOf(SYNC_RUN_STATUSES, value);
}

/** Why a Catalogue record sits in quarantine instead of the Mirror. */
export const QUARANTINE_REASONS = ['validation_failed', 'unknown_facet_value'] as const;

export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];
