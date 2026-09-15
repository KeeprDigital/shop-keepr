import type { QuarantineReason, SyncKind, SyncRunStatus } from '../../../shared/domain/sync-run';
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QUARANTINE_REASONS, SYNC_KINDS, SYNC_RUN_STATUSES } from '../../../shared/domain/sync-run';
import { epochMs, ulid } from '../columns';

/**
 * The Mirror (spec §4.2; ADR 0008, ADR 0009): shop-keepr's copy of the
 * Catalogue, holding no fact of its own. Every row here came from a
 * Catalogue record and is rebuilt by walking the Catalogue again; the sync
 * module is the only writer. Mirror tables carry no `store_id`: the Catalogue
 * knows nothing about stores.
 *
 * Indexes on `printing` are not declared here: the sync module builds them
 * after a seed (`CREATE INDEX IF NOT EXISTS`, spec §4.5), because each index
 * multiplies the rows written per Printing.
 */

/**
 * The shared read model: identity and display, nothing game-specific. Read
 * by stock, the ledger, Baskets, sessions and repricing; the only Mirror
 * table anything outside search touches (spec §3, _Mirror reference_).
 */
export const printing = sqliteTable('printing', {
	/** The Catalogue's opaque Printing id, verbatim, never parsed. */
	id: text().primaryKey(),
	/** The Catalogue's Card id; result grouping is `GROUP BY card_id`. */
	cardId: text().notNull(),
	gameSystem: text().notNull(),
	name: text().notNull(),
	setCode: text().notNull(),
	collectorNumber: text(),
	/** Normalised rarity code from the Catalogue; null is normal. */
	rarity: text(),
	/** The game's finish or variant code, for display; null when the game has none. */
	finish: text(),
	/** The Catalogue's CDN URLs, JSON `[{ face, thumbnail, full }]`, nothing copied. */
	images: text().notNull(),
	/**
	 * Integer minor units of `market_price_currency`, the Catalogue's currency,
	 * so not `Money`, which is minor units of the Store's own (spec §6, _FX_).
	 * Written only when the value moved, never overwritten with null.
	 */
	marketPrice: integer({ mode: 'number' }),
	marketPriceCurrency: text(),
	/** The Catalogue cursor at which the Market Price last moved. */
	marketPriceCursor: text(),
	/** Epoch-ms of the last movement; the reprice watermark. */
	marketPriceUpdatedAt: epochMs(),
	/** Row stays; kiosk hides, staff see a badge, still sellable. */
	withdrawn: integer({ mode: 'boolean' }).notNull(),
	/** The change cursor of the record this row holds; a record applies only if its cursor is at or after it. */
	cursor: text().notNull(),
	syncedAt: epochMs().notNull(),
});

/**
 * The Catalogue's whole record verbatim, 1:1 with `printing`, plus the
 * content hash the sync compares before every write (hash match = read, not
 * write). Read on detail render only; no `json_extract` in a hot query.
 */
export const printingDetail = sqliteTable('printing_detail', {
	printingId: text().primaryKey().references(() => printing.id),
	/** The Catalogue record as JSON, field names untouched. */
	record: text().notNull(),
	contentHash: text().notNull(),
	/** The record's change cursor, guarding this row as `printing.cursor` guards its twin. */
	cursor: text().notNull(),
	syncedAt: epochMs().notNull(),
});

/** A Game System's sets, synced as records; filter dropdowns read these. */
export const catalogueSet = sqliteTable('catalogue_set', {
	gameSystem: text().notNull(),
	code: text().notNull(),
	name: text().notNull(),
	/** ISO date, as the Catalogue states it; null when unknown. */
	releasedOn: text(),
	cursor: text().notNull(),
	contentHash: text().notNull(),
	syncedAt: epochMs().notNull(),
}, table => [
	primaryKey({ columns: [table.gameSystem, table.code] }),
]);

/**
 * One value of one Facet's value list for one Game System (rarities,
 * colours, card types, variants). Filter controls read these; nothing
 * hardcodes a rarity name or `DISTINCT`-scans Printings.
 */
export const catalogueVocabulary = sqliteTable('catalogue_vocabulary', {
	gameSystem: text().notNull(),
	/** The attribute key the value belongs to, e.g. `rarity`. */
	facet: text().notNull(),
	code: text().notNull(),
	name: text().notNull(),
	sortOrder: integer({ mode: 'number' }).notNull(),
	cursor: text().notNull(),
	contentHash: text().notNull(),
	syncedAt: epochMs().notNull(),
}, table => [
	primaryKey({ columns: [table.gameSystem, table.facet, table.code] }),
]);

/**
 * History and the lock (spec §5, _Idempotency, ordering, lock_): one
 * `running` row per kind, claimed by a conditional insert. The stored cursor
 * for a (kind, Game System) is `cursor_to` of its latest run that is no
 * longer running; every applied page advances it in the same `batch()`.
 */
export const syncRun = sqliteTable('sync_run', {
	id: ulid().primaryKey(),
	kind: text({ enum: SYNC_KINDS }).$type<SyncKind>().notNull(),
	gameSystem: text().notNull(),
	status: text({ enum: SYNC_RUN_STATUSES }).$type<SyncRunStatus>().notNull(),
	cursorFrom: text().notNull(),
	cursorTo: text().notNull(),
	recordsSeen: integer({ mode: 'number' }).notNull(),
	/** Printing records among those seen; a full walk compares it with the rows held to count absence. */
	printingsSeen: integer({ mode: 'number' }).notNull(),
	recordsWritten: integer({ mode: 'number' }).notNull(),
	recordsQuarantined: integer({ mode: 'number' }).notNull(),
	recordsDrifted: integer({ mode: 'number' }).notNull(),
	/** Market Price runs: movements for a Printing the Mirror lacks, left unapplied and counted (ADR 0009). */
	recordsSkipped: integer({ mode: 'number' }).notNull().default(0),
	error: text(),
	workflowInstanceId: text(),
	startedAt: epochMs().notNull(),
	/** Advanced with every page; how a stale `running` row is told from a live one. */
	updatedAt: epochMs().notNull(),
	finishedAt: epochMs(),
}, table => [
	index('sync_run_kind_game_started').on(table.kind, table.gameSystem, table.startedAt),
]);

/**
 * A record the run could not apply, kept with its raw payload so it can be
 * read back once the release that accepts it lands (ADR 0009). A full walk
 * clears the rows earlier runs of the same kind and Game System left.
 */
export const catalogueQuarantine = sqliteTable('catalogue_quarantine', {
	id: ulid().primaryKey(),
	syncRunId: text().notNull().references(() => syncRun.id),
	kind: text({ enum: SYNC_KINDS }).$type<SyncKind>().notNull(),
	gameSystem: text().notNull(),
	/** `printing`, `set` or `vocabulary` when the payload says; null when it does not. */
	recordKind: text(),
	recordId: text(),
	cursor: text(),
	reason: text({ enum: QUARANTINE_REASONS }).$type<QuarantineReason>().notNull(),
	/** JSON: the validation issues, or the facet and value that need a column. */
	detail: text().notNull(),
	/** The payload as pulled, JSON. */
	raw: text().notNull(),
	quarantinedAt: epochMs().notNull(),
}, table => [
	index('catalogue_quarantine_run').on(table.syncRunId),
]);
