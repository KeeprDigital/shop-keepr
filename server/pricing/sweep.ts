/**
 * The reprice sweep (spec §6, _The sweep_; ADR 0004): queue-backed,
 * chunked by SKU-id cursor, idempotent, resumable, one job per Store,
 * never request-time. A rule edit, an FX step and a Market Price run each
 * ask for one; the `reprice_sweep` row is the job and its progress line,
 * the queue message only the wake-up. The consumer runs one chunk per
 * message and sends the next, so a job of any size is a chain of short
 * steps and a mid-flight price is the previous price.
 *
 * Scope is `on_hand > 0 OR pinned` (a row pinned on both sides has
 * nothing to write and is left out); a Market Price sweep narrows to rows
 * whose `priced_at` is behind their Printing's watermark. Every dependent
 * write carries its guard in SQL (ADR 0011): the progress row advances
 * only from the cursor the chunk read, so a request folded in meanwhile
 * (scope widened, cursor back to the start) is never overwritten, and a
 * second job is never queued while one is queued or running.
 */
import type { RepriceReason, RepriceStatus } from '../../shared/domain/reprice';
import type { Db } from '../db/client';
import type { SkuPriceRow } from './reprice';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { printing, repriceSweep, sku } from '../db/schema';
import { prepared } from '../ledger/statement';
import { newId } from '../utils/ids';
import { STORE_ID } from '../utils/store';
import { loadPricingContext } from './context';
import { repriceRows, SKU_PRICE_COLUMNS } from './reprice';

export interface RepriceMessage {
	sweepId: string;
}

/** Whatever can carry the wake-up: the Queue binding in production, a list in a test. */
export interface RepriceQueue {
	send: (message: RepriceMessage) => Promise<void>;
}

/** SKUs per chunk: a handful of `batch()` statements, well inside a Queue consumer's time. */
export const SWEEP_CHUNK = 200;

/** A `running` job with no progress for this long is woken again by the cron. */
export const STALLED_SWEEP_AFTER_MS = 10 * 60 * 1_000;

export interface SweepScope {
	/** Game System codes, or null for the whole Store. */
	games: readonly string[] | null;
	/** Only SKUs whose `priced_at` is behind their Printing's Market Price watermark. */
	watermark: boolean;
}

export interface SweepRequest extends SweepScope {
	reason: RepriceReason;
	now?: number;
}

export interface SweepRequested {
	sweepId: string;
	/** True when a job was already queued or running and this request widened it instead of starting another. */
	folded: boolean;
}

export interface RepriceProgress {
	id: string;
	status: RepriceStatus;
	reason: RepriceReason;
	games: string[] | null;
	watermark: boolean;
	total: number;
	done: number;
	error: string | null;
	requestedAt: number;
	startedAt: number | null;
	finishedAt: number | null;
}

const ACTIVE: readonly RepriceStatus[] = ['queued', 'running'];

/** The rows a sweep visits, from `after` on: on hand or pinned on one side, in scope, behind the watermark when asked. */
function scopeWhere({ games, watermark }: SweepScope, after = '') {
	return and(
		eq(sku.storeId, STORE_ID),
		gt(sku.id, after),
		or(gt(sku.onHand, 0), eq(sku.sellPriceSource, 'pinned'), eq(sku.buyPriceSource, 'pinned')),
		or(eq(sku.sellPriceSource, 'rule'), eq(sku.buyPriceSource, 'rule')),
		games === null ? undefined : inArray(printing.gameSystem, [...games]),
		watermark ? or(isNull(sku.pricedAt), lt(sku.pricedAt, printing.marketPriceUpdatedAt)) : undefined,
	);
}

/** How many SKUs a sweep of `scope` would visit: what the Save confirm names. */
export async function estimateSweep(db: Db, scope: SweepScope): Promise<number> {
	const [row] = await db.select({ n: sql<number>`COUNT(*)` }).from(sku).innerJoin(printing, eq(printing.id, sku.printingId)).where(scopeWhere(scope));
	return row?.n ?? 0;
}

function unionScope(a: SweepScope, b: SweepScope): SweepScope {
	return {
		games: a.games === null || b.games === null ? null : [...new Set([...a.games, ...b.games])],
		watermark: a.watermark && b.watermark,
	};
}

/** Widens the active job to cover `asked` too and sends it back to the start; false when it settled first. */
async function foldInto(db: Db, active: typeof repriceSweep.$inferSelect, asked: SweepScope, now: number): Promise<boolean> {
	const scope = unionScope({ games: active.games === null ? null : JSON.parse(active.games) as string[], watermark: active.watermark }, asked);
	const total = await estimateSweep(db, scope);
	const folded = await prepared(db, sql`
		UPDATE reprice_sweep SET games = ${scope.games === null ? null : JSON.stringify(scope.games)}, watermark = ${scope.watermark}, cursor = '', done = 0, total = ${total}, updated_at = ${now}
		WHERE id = ${active.id} AND status IN ('queued', 'running')
	`).run();
	return folded.meta.changes === 1;
}

/** A `queued` row, by conditional insert: null when another job took the Store's one slot first. */
async function insertQueued(db: Db, asked: SweepScope, reason: RepriceReason, now: number): Promise<string | null> {
	const sweepId = newId();
	const total = await estimateSweep(db, asked);
	const inserted = await prepared(db, sql`
		INSERT INTO reprice_sweep (id, store_id, status, reason, games, watermark, cursor, total, done, error, requested_at, started_at, updated_at, finished_at)
		SELECT ${sweepId}, ${STORE_ID}, 'queued', ${reason}, ${asked.games === null ? null : JSON.stringify(asked.games)}, ${asked.watermark}, '', ${total}, 0, NULL, ${now}, NULL, ${now}, NULL
		WHERE NOT EXISTS (SELECT 1 FROM reprice_sweep WHERE store_id = ${STORE_ID} AND status IN ('queued', 'running'))
	`).run();
	return inserted.meta.changes === 1 ? sweepId : null;
}

/**
 * Asks for a sweep. One job per Store: a request while one is queued or
 * running is folded into it, widening its scope and sending it back to
 * the start, and sends no message; otherwise a `queued` row lands by
 * conditional insert and one message wakes the consumer.
 */
export async function requestSweep(db: Db, queue: RepriceQueue, { reason, games, watermark, now = Date.now() }: SweepRequest): Promise<SweepRequested> {
	const asked: SweepScope = { games: games === null ? null : [...games], watermark };
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const active = await db.query.repriceSweep.findFirst({ where: and(eq(repriceSweep.storeId, STORE_ID), inArray(repriceSweep.status, [...ACTIVE])) });
		// An active job that settles between the read and the fold is left alone; a fresh one starts.
		if (active && await foldInto(db, active, asked, now)) {
			return { sweepId: active.id, folded: true };
		}
		const sweepId = await insertQueued(db, asked, reason, now);
		if (sweepId !== null) {
			await queue.send({ sweepId });
			return { sweepId, folded: false };
		}
	}
	throw new Error('The reprice sweep could not be queued: another request kept taking the slot');
}

export interface ChunkOutcome {
	sweepId: string;
	status: RepriceStatus;
	done: number;
	total: number;
	/** True when nothing remains: the job is done, failed, or was already settled. */
	finished: boolean;
}

/** Takes the job for a chunk: `queued` becomes `running`; a settled job is not taken. */
async function startChunk(db: Db, sweepId: string, now: number): Promise<{ job: typeof repriceSweep.$inferSelect; taken: boolean }> {
	const started = await prepared(db, sql`
		UPDATE reprice_sweep SET status = 'running', started_at = COALESCE(started_at, ${now}), updated_at = ${now}
		WHERE id = ${sweepId} AND status IN ('queued', 'running')
	`).run();
	const job = await db.query.repriceSweep.findFirst({ where: eq(repriceSweep.id, sweepId) });
	if (!job) {
		throw new Error(`reprice_sweep ${sweepId} does not exist`);
	}
	return { job, taken: started.meta.changes === 1 && job.status === 'running' };
}

async function failSweep(db: Db, sweepId: string, error: unknown, now: number): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	await prepared(db, sql`UPDATE reprice_sweep SET status = 'failed', error = ${message}, finished_at = ${now}, updated_at = ${now} WHERE id = ${sweepId} AND status = 'running'`).run();
}

/**
 * One chunk of the job: take the next SKUs past the cursor, reprice the
 * sides the rules own, advance the cursor. Called once per queue message;
 * the caller sends the next message while `finished` is false. A message
 * for a settled job is a replay and does nothing.
 */
export async function runSweepChunk(db: Db, { sweepId, now = Date.now(), chunk = SWEEP_CHUNK }: { sweepId: string; now?: number; chunk?: number }): Promise<ChunkOutcome> {
	const { job, taken } = await startChunk(db, sweepId, now);
	if (!taken) {
		return { sweepId, status: job.status, done: job.done, total: job.total, finished: true };
	}
	const scope: SweepScope = { games: job.games === null ? null : JSON.parse(job.games) as string[], watermark: job.watermark };
	try {
		const ctx = await loadPricingContext(db);
		const rows: SkuPriceRow[] = await db.select(SKU_PRICE_COLUMNS).from(sku).innerJoin(printing, eq(printing.id, sku.printingId)).where(scopeWhere(scope, job.cursor)).orderBy(asc(sku.id)).limit(chunk);
		await repriceRows(db, ctx, rows, { sides: ['sell', 'buy'], now });
		const exhausted = rows.length < chunk;
		const advanced = await advanceCursor(db, { sweepId, from: job.cursor, to: rows.at(-1)?.id ?? job.cursor, count: rows.length, exhausted, now });
		// A miss means a request was folded in meanwhile and the cursor went back: carry on from where the row now says.
		const after = (await db.query.repriceSweep.findFirst({ where: eq(repriceSweep.id, sweepId) }))!;
		return { sweepId, status: after.status, done: after.done, total: after.total, finished: (advanced && exhausted) || !ACTIVE.includes(after.status) };
	}
	catch (error) {
		await failSweep(db, sweepId, error, now);
		throw error;
	}
}

/** The progress write after a chunk, guarded on the cursor the chunk read; settles the job when the chunk was the last. */
async function advanceCursor(db: Db, { sweepId, from, to, count, exhausted, now }: { sweepId: string; from: string; to: string; count: number; exhausted: boolean; now: number }): Promise<boolean> {
	const settle = exhausted ? sql`status = 'done', finished_at = ${now},` : sql``;
	const result = await prepared(db, sql`
		UPDATE reprice_sweep SET ${settle} cursor = ${to}, done = done + ${count}, updated_at = ${now}
		WHERE id = ${sweepId} AND status = 'running' AND cursor = ${from}
	`).run();
	return result.meta.changes === 1;
}

/** Every chunk until the job settles, inline; how tests and the local script drive what the queue drives in production. */
export async function drainSweep(db: Db, { sweepId, now, chunk }: { sweepId: string; now?: number; chunk?: number }): Promise<ChunkOutcome> {
	for (;;) {
		const outcome = await runSweepChunk(db, { sweepId, now, chunk });
		if (outcome.finished) {
			return outcome;
		}
	}
}

/** The job in flight, or the latest settled one; null when the Store has never swept. */
export async function readRepriceProgress(db: Db): Promise<RepriceProgress | null> {
	const row = await db.query.repriceSweep.findFirst({
		where: eq(repriceSweep.storeId, STORE_ID),
		orderBy: [sql`CASE WHEN ${repriceSweep.status} IN ('queued', 'running') THEN 0 ELSE 1 END`, sql`${repriceSweep.requestedAt} DESC`],
	});
	if (!row) {
		return null;
	}
	return {
		id: row.id,
		status: row.status,
		reason: row.reason,
		games: row.games === null ? null : JSON.parse(row.games) as string[],
		watermark: row.watermark,
		total: row.total,
		done: row.done,
		error: row.error,
		requestedAt: row.requestedAt,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
	};
}

/** Jobs queued or running with no progress for `STALLED_SWEEP_AFTER_MS`: woken again with a fresh message. The cron's hygiene. */
export async function wakeStalledSweeps(db: Db, queue: RepriceQueue, now = Date.now()): Promise<string[]> {
	const stalled = await db.select({ id: repriceSweep.id }).from(repriceSweep).where(and(eq(repriceSweep.storeId, STORE_ID), inArray(repriceSweep.status, [...ACTIVE]), lt(repriceSweep.updatedAt, now - STALLED_SWEEP_AFTER_MS)));
	for (const { id } of stalled) {
		await prepared(db, sql`UPDATE reprice_sweep SET updated_at = ${now} WHERE id = ${id}`).run();
		await queue.send({ sweepId: id });
	}
	return stalled.map(row => row.id);
}
