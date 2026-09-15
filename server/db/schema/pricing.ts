import type { RepriceReason, RepriceStatus } from '../../../shared/domain/reprice';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { REPRICE_REASONS, REPRICE_STATUSES } from '../../../shared/domain/reprice';
import { epochMs, storeId, ulid } from '../columns';
import { store } from './store';

/**
 * The Pricing Rules (spec §6, _Store settings_; ADR 0004): one row per
 * setting per scope, its value as JSON in the shape `shared/pricing`
 * declares. `scope` is `store` for the defaults or a Game System code;
 * `side` is `sell`, `buy`, or `rows` for a Game System's attribute rows,
 * which belong to both sides at once. A Game System holds a row only
 * where it overrides the Store; resolution is per setting, in code. The
 * seed migration inserts every Store row, and the read path refuses to
 * price without them.
 */
export const pricingSetting = sqliteTable('pricing_setting', {
	storeId: storeId().references(() => store.id),
	scope: text().notNull(),
	side: text().notNull(),
	key: text().notNull(),
	/** JSON, validated against the setting's Zod schema on the way in. */
	value: text().notNull(),
	updatedAt: epochMs().notNull(),
}, table => [
	primaryKey({ columns: [table.storeId, table.scope, table.side, table.key] }),
]);

/**
 * The reprice sweep (spec §6, _The sweep_; ADR 0004): one job per Store,
 * queue-backed, chunked by SKU-id cursor, idempotent, resumable. The row
 * is the job's state and its progress line; the queue message is only
 * the wake-up. A request that arrives while a job is queued or running
 * is folded into it: the scope widens and the cursor returns to the
 * start, so every SKU the later request named is still visited.
 */
export const repriceSweep = sqliteTable('reprice_sweep', {
	id: ulid().primaryKey(),
	storeId: storeId().references(() => store.id),
	status: text({ enum: REPRICE_STATUSES }).$type<RepriceStatus>().notNull(),
	reason: text({ enum: REPRICE_REASONS }).$type<RepriceReason>().notNull(),
	/** JSON array of Game System codes, or null for the whole Store. */
	games: text(),
	/** Only SKUs whose `priced_at` is behind their Printing's Market Price watermark. */
	watermark: integer({ mode: 'boolean' }).notNull(),
	/** The last SKU id repriced; empty at the start. */
	cursor: text().notNull(),
	/** SKUs in scope when the job started; the progress line's denominator. */
	total: integer({ mode: 'number' }).notNull(),
	done: integer({ mode: 'number' }).notNull(),
	error: text(),
	requestedAt: epochMs().notNull(),
	startedAt: epochMs(),
	/** Advanced with every chunk; how a stalled job is told from a live one. */
	updatedAt: epochMs().notNull(),
	finishedAt: epochMs(),
}, table => [
	index('reprice_sweep_store_status').on(table.storeId, table.status),
	index('reprice_sweep_store_requested').on(table.storeId, table.requestedAt),
]);
