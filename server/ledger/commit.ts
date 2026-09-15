/**
 * The one commit batch every ledger writer shares (spec §3, _Write paths
 * and atomicity_): header insert, line inserts, `sku` upsert per line,
 * `on_hand` update per line, all in one `batch()`. `batch()` is atomic but
 * not conditional, so every statement that depends on an earlier one
 * carries its own guard in SQL (spec §4.1; ADR 0011):
 *
 * - the SKU rows are made to exist first, at `on_hand` 0, so every later
 *   statement can read them;
 * - the header inserts only while every line's stock condition holds, so
 *   an entry that would take `on_hand` below zero never lands;
 * - each line inserts only while its header exists, and copies the card's
 *   name, number, set and rarity from the Mirror at that moment;
 * - each `on_hand` update applies only while its line exists.
 *
 * The header's `meta.changes` says whether the entry landed at all.
 */
import type { Condition } from '../../shared/domain/condition';
import type { Language } from '../../shared/domain/language';
import type { LedgerKind, LedgerReason, Origin, Tender } from '../../shared/domain/ledger';
import type { Money } from '../../shared/domain/money';
import type { Db } from '../db/client';
import type { Actor } from './actor';
import { sql } from 'drizzle-orm';
import { STORE_ID } from '../utils/store';
import { prepared } from './statement';

export interface EntryHeader {
	id: string;
	kind: LedgerKind;
	createdAt: number;
	actor: Actor;
	origin?: Origin | null;
	posReference?: string | null;
	basketId?: string | null;
	tradeId?: string | null;
	tender?: Tender | null;
	tenderModifierPct?: number | null;
	totalPct?: number | null;
	remainderTender?: Tender | null;
	total?: Money | null;
	net?: Money | null;
	reason?: LedgerReason | null;
	note?: string | null;
	reverses?: string | null;
	customerName?: string | null;
}

export interface EntryLine {
	id: string;
	/** The SKU's id if it already has a row, else the id its row is created with. */
	skuId: string;
	printingId: string;
	condition: Condition;
	language: Language;
	/** Signed: stock in positive, stock out negative. */
	quantity: number;
	listPrice?: Money | null;
	transactedPrice?: Money | null;
	/**
	 * What must be true of the SKU's `on_hand` for the entry to land, given
	 * the on-hand the writer read: a delta may not take it below zero, a
	 * count must land on what was read. Both hold on this SKU's row.
	 */
	guard: { minOnHand: number } | { onHand: number };
}

export interface CommitPlan {
	header: EntryHeader;
	lines: EntryLine[];
}

/** One line's stock condition, against the SKU row it names. */
function stockCondition(line: EntryLine) {
	const onHand = sql`(SELECT on_hand FROM sku WHERE id = ${line.skuId})`;
	return 'onHand' in line.guard
		? sql`${onHand} = ${line.guard.onHand}`
		: sql`${onHand} >= ${line.guard.minOnHand}`;
}

/** The batch's statements in the order they must run; the header is the second statement group. */
export function commitStatements(db: Db, { header, lines }: CommitPlan) {
	const { actor } = header;
	const skuUpserts = lines.map(line => prepared(db, sql`
		INSERT INTO sku (id, store_id, printing_id, condition, language, on_hand, created_at, updated_at)
		SELECT ${line.skuId}, ${STORE_ID}, ${line.printingId}, ${line.condition}, ${line.language}, 0, ${header.createdAt}, ${header.createdAt}
		WHERE EXISTS (SELECT 1 FROM printing WHERE id = ${line.printingId})
		ON CONFLICT (store_id, printing_id, condition, language) DO NOTHING
	`));
	const conditions = lines.map(stockCondition);
	const headerInsert = prepared(db, sql`
		INSERT INTO ledger_entry (id, store_id, kind, created_at, surface, session_id, staff_user_id, origin, pos_reference, basket_id, trade_id, tender, tender_modifier_pct, total_pct, remainder_tender, total, net, reason, note, reverses, customer_name)
		SELECT ${header.id}, ${STORE_ID}, ${header.kind}, ${header.createdAt}, ${actor.surface}, ${actor.sessionId}, ${actor.staffUserId},
			${header.origin ?? null}, ${header.posReference ?? null}, ${header.basketId ?? null}, ${header.tradeId ?? null},
			${header.tender ?? null}, ${header.tenderModifierPct ?? null}, ${header.totalPct ?? null}, ${header.remainderTender ?? null},
			${header.total ?? null}, ${header.net ?? null}, ${header.reason ?? null}, ${header.note ?? null}, ${header.reverses ?? null}, ${header.customerName ?? null}
		WHERE ${sql.join(conditions, sql` AND `)}
	`);
	const lineInserts = lines.map(line => prepared(db, sql`
		INSERT INTO ledger_line (id, entry_id, store_id, printing_id, condition, language, sku_id, quantity, card_name, collector_number, set_code, rarity, list_price, transacted_price)
		SELECT ${line.id}, ${header.id}, ${STORE_ID}, ${line.printingId}, ${line.condition}, ${line.language}, ${line.skuId}, ${line.quantity},
			name, collector_number, set_code, rarity, ${line.listPrice ?? null}, ${line.transactedPrice ?? null}
		FROM printing
		WHERE id = ${line.printingId} AND EXISTS (SELECT 1 FROM ledger_entry WHERE id = ${header.id})
	`));
	const onHandUpdates = lines.map(line => prepared(db, sql`
		UPDATE sku SET on_hand = on_hand + ${line.quantity}, updated_at = ${header.createdAt}
		WHERE id = ${line.skuId} AND EXISTS (SELECT 1 FROM ledger_line WHERE id = ${line.id})
	`));
	return { skuUpserts, headerInsert, lineInserts, onHandUpdates };
}

export type CommitOutcome
	= | { landed: true }
	/** A stock condition failed: nothing was written. */
		| { landed: false };

/** Runs the commit batch and reports whether the entry landed. */
export async function commitEntry(db: Db, plan: CommitPlan): Promise<CommitOutcome> {
	const { skuUpserts, headerInsert, lineInserts, onHandUpdates } = commitStatements(db, plan);
	const results = await db.$client.batch([...skuUpserts, headerInsert, ...lineInserts, ...onHandUpdates]);
	return { landed: results[skuUpserts.length]!.meta.changes === 1 };
}
