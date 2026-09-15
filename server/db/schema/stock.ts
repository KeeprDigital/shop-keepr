import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { LedgerKind, LedgerReason, Origin, Surface, Tender } from '../../../shared/domain/ledger';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { LEDGER_KINDS, LEDGER_REASONS, ORIGINS, SURFACES, TENDERS } from '../../../shared/domain/ledger';
import { condition, epochMs, language, minorUnits, storeId, ulid } from '../columns';
import { printing } from './catalogue';
import { store } from './store';

/**
 * Stock (spec §3; ADR 0001, ADR 0002): a SKU is a Printing in a Condition
 * and Language held by one Store, and its `on_hand` is a materialised
 * projection of the append-only ledger, written in the same `batch()` as
 * the ledger rows and healed by the reconcile job when the two drift.
 */

/**
 * The unit the store counts, prices, holds and transacts. A row appears at
 * the first Adjustment or Buy that touches it, never speculatively; rows
 * are never deleted, and may sit at `on_hand = 0`. The pricing columns
 * (Sell and Buy Price, sources, pins, `priced_at`) arrive with the pricing
 * ticket.
 */
export const sku = sqliteTable('sku', {
	id: ulid().primaryKey(),
	storeId: storeId().references(() => store.id),
	/** The Catalogue's opaque Printing id, verbatim. */
	printingId: text().notNull().references(() => printing.id),
	condition: condition().notNull(),
	/** `NOT NULL`: a nullable key column would split one pile into several (ADR 0002). */
	language: language().notNull(),
	/** `SUM(ledger_line.quantity)` for this SKU, materialised; never negative. */
	onHand: integer({ mode: 'number' }).notNull(),
	createdAt: epochMs().notNull(),
	updatedAt: epochMs().notNull(),
}, table => [
	uniqueIndex('sku_key').on(table.storeId, table.printingId, table.condition, table.language),
]);

/**
 * One Buy, Sell or Adjustment: the header. Rows are never updated or
 * deleted, with one exception: `pos_reference` is editable afterwards. A
 * mistake is corrected by a compensating entry pointing back through
 * `reverses` (ADR 0001).
 */
export const ledgerEntry = sqliteTable('ledger_entry', {
	id: ulid().primaryKey(),
	storeId: storeId().references(() => store.id),
	kind: text({ enum: LEDGER_KINDS }).$type<LedgerKind>().notNull(),
	/** Commit time; no backdating. */
	createdAt: epochMs().notNull(),
	surface: text({ enum: SURFACES }).$type<Surface>().notNull(),
	/** The Better Auth session that wrote the row: one shift on one terminal. */
	sessionId: text().notNull(),
	/** Null until per-staff login; the column is the migration. */
	staffUserId: text(),
	/** Buy and Sell only. */
	origin: text({ enum: ORIGINS }).$type<Origin>(),
	/** Buy and Sell only: opaque, non-empty, not unique, never validated. */
	posReference: text(),
	/** Kiosk Sells only. */
	basketId: text(),
	/** The same value on both halves of a Trade (ADR 0007). */
	tradeId: text(),
	/** Buy only. */
	tender: text({ enum: TENDERS }).$type<Tender>(),
	/** Buy only: signed percentage, as applied. */
	tenderModifierPct: integer({ mode: 'number' }),
	/** Buy and counter or list Sell: signed integer −100..+100. */
	totalPct: integer({ mode: 'number' }),
	/** Trade Buy only, when a Remainder exists. */
	remainderTender: text({ enum: TENDERS }).$type<Tender>(),
	/** The side's own worth as settled; signed from the store's perspective. */
	total: minorUnits(),
	/** Money that moved at the till; a snapshot, never recomputed. */
	net: minorUnits(),
	/** An Adjustment Reason, or a Reversal Reason when `reverses` is set. */
	reason: text({ enum: LEDGER_REASONS }).$type<LedgerReason>(),
	/** Required with Reversal Reason `other`. */
	note: text(),
	/** The entry this one compensates. */
	reverses: text().references((): AnySQLiteColumn => ledgerEntry.id),
	/** Buy only, free text; there is no customer entity. */
	customerName: text(),
}, table => [
	index('ledger_entry_store_created').on(table.storeId, table.createdAt),
	index('ledger_entry_store_pos_reference').on(table.storeId, table.posReference),
	index('ledger_entry_store_trade').on(table.storeId, table.tradeId),
	index('ledger_entry_reverses').on(table.reverses),
]);

/**
 * One row per SKU per entry, signed quantity: Buy positive, Sell negative,
 * Adjustment either. Carries the card's name, number, set and rarity as
 * text written once, so a five-year-old line reads without the Mirror
 * (ADR 0001). The Buy-only pricing snapshots (unit price at quantity one,
 * the Quantity Band factor) arrive with the Buy ticket, which fixes their
 * shape.
 */
export const ledgerLine = sqliteTable('ledger_line', {
	id: ulid().primaryKey(),
	entryId: text().notNull().references(() => ledgerEntry.id),
	storeId: storeId().references(() => store.id),
	/** The SKU key, carried on the line. */
	printingId: text().notNull().references(() => printing.id),
	condition: condition().notNull(),
	language: language().notNull(),
	/** Resolved at commit, after the upsert. */
	skuId: text().notNull().references(() => sku.id),
	quantity: integer({ mode: 'number' }).notNull(),
	cardName: text().notNull(),
	collectorNumber: text(),
	setCode: text().notNull(),
	rarity: text(),
	/** Per copy; null on an Adjustment. */
	listPrice: minorUnits(),
	/** Per copy, staff-editable; null on an Adjustment. */
	transactedPrice: minorUnits(),
}, table => [
	index('ledger_line_entry').on(table.entryId),
	index('ledger_line_store_sku_entry').on(table.storeId, table.skuId, table.entryId),
]);

/**
 * Every heal the reconcile job made (spec §3, _Reconcile job_): the stored
 * `on_hand` it found and the ledger's answer it wrote. An empty table means
 * healthy. A heal is never a ledger entry.
 */
export const projectionDrift = sqliteTable('projection_drift', {
	id: ulid().primaryKey(),
	storeId: storeId().references(() => store.id),
	skuId: text().notNull().references(() => sku.id),
	storedOnHand: integer({ mode: 'number' }).notNull(),
	ledgerOnHand: integer({ mode: 'number' }).notNull(),
	healedAt: epochMs().notNull(),
}, table => [
	index('projection_drift_store_healed').on(table.storeId, table.healedAt),
]);
