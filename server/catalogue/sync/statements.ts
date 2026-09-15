/**
 * The write half of a page (spec §5, _Write shape_): the plan turned into
 * SQL. Inline escaped literals packed under the statement cap, one
 * `batch()` per page, and every dependent statement carrying its own guard
 * in SQL because `batch()` is atomic but not conditional (spec §4.1; ADR
 * 0011):
 *
 * - an upsert applies only while the incoming cursor is at or after the
 *   row's, so a replayed or reordered page cannot roll a row back;
 * - a Market Price never overwrites a good rate with null, and moves the
 *   watermark only when the value moved;
 * - the quarantine rows and the run's counters apply only while the run is
 *   still on the cursor the page started from, so a replayed page cannot
 *   double-count or double-quarantine.
 *
 * The game's search table, its FTS5 index and the trigram vocabulary are
 * written in the same batch by the search module's write side (ADR 0008).
 */
import type { Cursor, PrintingRecord, SetRecord, VocabularyRecord } from '../generated/types.gen';
import type { PagePlan, Quarantined, Write } from './plan';
import type { RunRef } from './run';
import { literal, packRows, tuple } from '../../db/sql';
import { searchStatements } from '../../search/mirror';
import { displayFinish } from './facets';

export interface PageWriteContext extends RunRef {
	/** The cursor the page started from: the run's `cursor_to` while this page is unapplied. */
	cursor: Cursor;
	nextCursor: Cursor;
	now: number;
	newId: () => string;
}

/** Every statement of the page, in the order the batch must run them. */
export function pageStatements(plan: PagePlan, ctx: PageWriteContext): string[] {
	return [
		...setStatements(plan.sets, ctx),
		...vocabularyStatements(plan.vocabularies, ctx),
		...printingStatements(plan.printings, ctx),
		...printingDetailStatements(plan.printings, ctx),
		...searchStatements(ctx.game, plan.printings.map(w => w.record), ctx),
		...quarantineStatements(plan.quarantined, ctx),
		runProgressStatement(plan, ctx),
	];
}

/** The tail every synced table's upsert shares: the sync columns, guarded by the row's cursor. */
function syncedUpsertTail(table: string, key: string[], columns: string): string {
	return ` ON CONFLICT(${key.join(', ')}) DO UPDATE SET ${columns}, cursor = excluded.cursor, content_hash = excluded.content_hash, synced_at = excluded.synced_at WHERE excluded.cursor >= ${table}.cursor`;
}

function setStatements(writes: Write<SetRecord>[], { game, now }: PageWriteContext): string[] {
	return packRows(
		'INSERT INTO catalogue_set (game_system, code, name, released_on, cursor, content_hash, synced_at) VALUES ',
		writes.map(({ record, hash }) => tuple([game, record.code, record.name, record.released_on, record.cursor, hash, now])),
		syncedUpsertTail('catalogue_set', ['game_system', 'code'], 'name = excluded.name, released_on = excluded.released_on'),
	);
}

function vocabularyStatements(writes: Write<VocabularyRecord>[], { game, now }: PageWriteContext): string[] {
	return packRows(
		'INSERT INTO catalogue_vocabulary (game_system, facet, code, name, sort_order, cursor, content_hash, synced_at) VALUES ',
		writes.map(({ record, hash }) => tuple([game, record.facet, record.code, record.name, record.sort_order, record.cursor, hash, now])),
		syncedUpsertTail('catalogue_vocabulary', ['game_system', 'facet', 'code'], 'name = excluded.name, sort_order = excluded.sort_order'),
	);
}

/** The incoming Market Price applies when it is a value and not behind the rate held. */
const PRICE_APPLIES = 'excluded.market_price IS NOT NULL AND (printing.market_price_cursor IS NULL OR excluded.market_price_cursor >= printing.market_price_cursor)';

/** The `printing` upsert alone; the recall script writes a corpus through it. */
export function printingStatements(writes: Write<PrintingRecord>[], { game, now }: Pick<PageWriteContext, 'game' | 'now'>): string[] {
	return packRows(
		'INSERT INTO printing (id, card_id, game_system, name, set_code, collector_number, rarity, finish, images, market_price, market_price_currency, market_price_cursor, market_price_updated_at, withdrawn, cursor, synced_at) VALUES ',
		writes.map(({ record }) => tuple([
			record.id,
			record.card_id,
			game,
			record.name,
			record.set_code,
			record.collector_number,
			record.rarity,
			displayFinish(record),
			JSON.stringify(record.images),
			record.market_price?.amount ?? null,
			record.market_price?.currency ?? null,
			record.market_price === null ? null : record.market_price_cursor,
			record.market_price === null ? null : now,
			record.withdrawn,
			record.cursor,
			now,
		])),
		` ON CONFLICT(id) DO UPDATE SET`
		+ ` card_id = excluded.card_id, game_system = excluded.game_system, name = excluded.name, set_code = excluded.set_code, collector_number = excluded.collector_number, rarity = excluded.rarity, finish = excluded.finish, images = excluded.images,`
		+ ` market_price = CASE WHEN ${PRICE_APPLIES} THEN excluded.market_price ELSE printing.market_price END,`
		+ ` market_price_currency = CASE WHEN ${PRICE_APPLIES} THEN excluded.market_price_currency ELSE printing.market_price_currency END,`
		+ ` market_price_cursor = CASE WHEN ${PRICE_APPLIES} THEN excluded.market_price_cursor ELSE printing.market_price_cursor END,`
		+ ` market_price_updated_at = CASE WHEN ${PRICE_APPLIES} AND excluded.market_price IS NOT printing.market_price THEN excluded.synced_at ELSE printing.market_price_updated_at END,`
		+ ` withdrawn = excluded.withdrawn, cursor = excluded.cursor, synced_at = excluded.synced_at`
		+ ` WHERE excluded.cursor >= printing.cursor`,
	);
}

function printingDetailStatements(writes: Write<PrintingRecord>[], { now }: PageWriteContext): string[] {
	return packRows(
		'INSERT INTO printing_detail (printing_id, record, content_hash, cursor, synced_at) VALUES ',
		writes.map(({ record, hash }) => tuple([record.id, JSON.stringify(record), hash, record.cursor, now])),
		syncedUpsertTail('printing_detail', ['printing_id'], 'record = excluded.record'),
	);
}

/** The run is still on this page's starting cursor: the page has not been applied. */
function pageUnapplied({ runId, cursor }: PageWriteContext): string {
	return `EXISTS (SELECT 1 FROM sync_run WHERE id = ${literal(runId)} AND status = 'running' AND cursor_to = ${literal(cursor)})`;
}

/** The page's quarantine rows; shared with the Market Price run. */
export function quarantineStatements(quarantined: Quarantined[], ctx: PageWriteContext): string[] {
	const { runId, kind, game, now, newId } = ctx;
	return packRows(
		'INSERT INTO catalogue_quarantine (id, sync_run_id, kind, game_system, record_kind, record_id, cursor, reason, detail, raw, quarantined_at) SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9, column10, column11 FROM (VALUES ',
		quarantined.map(q => tuple([newId(), runId, kind, game, q.recordKind, q.recordId, q.cursor, q.reason, JSON.stringify(q.detail), JSON.stringify(q.raw) ?? 'null', now])),
		`) WHERE ${pageUnapplied(ctx)}`,
	);
}

/** The batch's last statement: the run's cursor and counters advance only while the page is unapplied. Shared with the Market Price run. */
export function runProgressStatement({ counts, printingsSeen }: Pick<PagePlan, 'counts'> & { printingsSeen?: number }, ctx: PageWriteContext): string {
	return `UPDATE sync_run SET cursor_to = ${literal(ctx.nextCursor)},`
		+ ` records_seen = records_seen + ${counts.seen}, printings_seen = printings_seen + ${printingsSeen ?? 0}, records_written = records_written + ${counts.written},`
		+ ` records_quarantined = records_quarantined + ${counts.quarantined}, records_drifted = records_drifted + ${counts.drifted}, records_skipped = records_skipped + ${counts.skipped},`
		+ ` updated_at = ${literal(ctx.now)}`
		+ ` WHERE id = ${literal(ctx.runId)} AND status = 'running' AND cursor_to = ${literal(ctx.cursor)}`;
}
