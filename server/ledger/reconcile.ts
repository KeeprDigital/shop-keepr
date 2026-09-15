/**
 * The reconcile job (spec §3, _Reconcile job and `projection_drift`_; ADR
 * 0001): recomputes `SUM(ledger_line.quantity)` per SKU, writes the
 * ledger's answer into `on_hand`, and records every heal. Run by cron and
 * on demand from the System page. An empty `projection_drift` means
 * healthy; a heal is never a ledger entry.
 *
 * Each heal is two guarded statements, every heal in one batch: the drift
 * row lands only while `on_hand` still holds the value the job read, and
 * the update only once its drift row exists, so a ledger write racing the
 * job leaves the SKU to the next run rather than overwriting it.
 */
import type { ReconcileOutcome } from '../../shared/contracts/staff/reconcile';
import type { Db } from '../db/client';
import { sql } from 'drizzle-orm';
import { newId } from '../utils/ids';
import { STORE_ID } from '../utils/store';
import { prepared } from './statement';

interface DriftRow {
	id: string;
	on_hand: number;
	ledger_on_hand: number;
}

export async function reconcileOnHand(db: Db, now = Date.now()): Promise<ReconcileOutcome> {
	const checked = await prepared(db, sql`SELECT COUNT(*) AS n FROM sku WHERE store_id = ${STORE_ID}`).first<{ n: number }>();
	const drifted = await prepared(db, sql`
		SELECT sku.id, sku.on_hand, COALESCE(SUM(ledger_line.quantity), 0) AS ledger_on_hand
		FROM sku LEFT JOIN ledger_line ON ledger_line.sku_id = sku.id
		WHERE sku.store_id = ${STORE_ID}
		GROUP BY sku.id
		HAVING sku.on_hand <> ledger_on_hand
		ORDER BY sku.id
	`).all<DriftRow>();
	if (drifted.results.length === 0) {
		return { checked: checked?.n ?? 0, healed: [] };
	}
	const statements = drifted.results.flatMap((row) => {
		const driftId = newId();
		return [
			sql`INSERT INTO projection_drift (id, store_id, sku_id, stored_on_hand, ledger_on_hand, healed_at)
				SELECT ${driftId}, ${STORE_ID}, ${row.id}, ${row.on_hand}, ${row.ledger_on_hand}, ${now}
				WHERE EXISTS (SELECT 1 FROM sku WHERE id = ${row.id} AND on_hand = ${row.on_hand})`,
			sql`UPDATE sku SET on_hand = ${row.ledger_on_hand}, updated_at = ${now}
				WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM projection_drift WHERE id = ${driftId})`,
		].map(statement => prepared(db, statement));
	});
	const results = await db.$client.batch(statements);
	const healed = drifted.results
		.filter((_, index) => results[index * 2]!.meta.changes === 1)
		.map(row => ({ skuId: row.id, storedOnHand: row.on_hand, ledgerOnHand: row.ledger_on_hand }));
	return { checked: checked?.n ?? 0, healed };
}
