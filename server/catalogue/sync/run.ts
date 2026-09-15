/**
 * The Catalogue sync run (ADR 0009; spec §5, _Sync: one cursor walk_): one
 * job fills, refreshes and heals the Mirror by walking one cursor per
 * (kind, Game System). A seed is the walk from cursor zero into an empty
 * Mirror, a delta the walk from the stored cursor, a reconcile the walk from
 * cursor zero into a full Mirror; hash-compare on every write makes them
 * one code path.
 *
 * `sync_run` is history and the lock: one `running` row per kind, claimed by
 * a conditional insert; the stored cursor for a (kind, Game System) is
 * `cursor_to` of its latest run no longer running. Every write that depends
 * on the run still holding the lock checks `meta.changes` (ADR 0011). The
 * job takes a database binding, never the database (tenancy hook), and a
 * `StepRunner` so the Workflow can make every page a durable step while a
 * script runs the same code inline.
 */
import type { SyncKind, SyncRunStatus } from '../../../shared/domain/sync-run';
import type { CatalogueClient } from '../client';
import type { Cursor } from '../generated/types.gen';
import type { Existing, ExistingRow, PageCounts } from './plan';
import { newId } from '../../utils/ids';
import { FIRST_CURSOR } from '../client';
import { MIRROR_INDEXES } from './indexes';
import { emptyExisting, planPage, vocabularyKey } from './plan';
import { literal, packRows } from './sql';
import { pageStatements } from './statements';

/** What the sync needs of D1; a Session provides both. */
export type D1Client = Pick<D1Database, 'prepare' | 'batch'>;

/**
 * A `running` row with no progress for this long is abandoned by the next
 * claim: 2x the expected duration of a run, a default chosen without a
 * census (spec §5, _Idempotency, ordering, lock_). Keyed on progress rather
 * than age so a live run is never abandoned under a second one.
 */
export const STALE_RUNNING_AFTER_MS = 2 * 60 * 60 * 1_000;

/** The run every stage works within. */
export interface RunRef {
	runId: string;
	kind: SyncKind;
	game: string;
}

export interface SyncRunSummary {
	id: string;
	kind: SyncKind;
	gameSystem: string;
	status: SyncRunStatus;
	cursorFrom: Cursor;
	cursorTo: Cursor;
	counts: PageCounts;
}

/** A second start while a run of the kind is `running`. */
export interface Refused {
	claimed: false;
	reason: 'running';
}

export type SyncOutcome = Refused | { claimed: true; run: SyncRunSummary };

export interface ClaimOptions {
	kind: SyncKind;
	game: string;
	/** Omit to resume from the stored cursor; `FIRST_CURSOR` seeds or reconciles. */
	fromCursor?: Cursor;
	now: number;
	workflowInstanceId?: string;
}

export type Claim = Refused | {
	claimed: true;
	runId: string;
	cursorFrom: Cursor;
	/** A full walk into a Mirror holding nothing of this Game System: indexes wait (spec §4.5). */
	seed: boolean;
};

/** The cursor the next run of this kind and Game System resumes from. */
export async function storedCursor(db: D1Client, kind: SyncKind, game: string): Promise<Cursor> {
	const row = await db
		.prepare(`SELECT cursor_to FROM sync_run WHERE kind = ?1 AND game_system = ?2 AND status <> 'running' ORDER BY started_at DESC LIMIT 1`)
		.bind(kind, game)
		.first<{ cursor_to: Cursor }>();
	return row?.cursor_to ?? FIRST_CURSOR;
}

/**
 * Takes the one `running` slot for the kind, abandoning a stale holder
 * first. Refused when a live run holds it, unless that run is this Workflow
 * instance's own (a replayed claim step).
 */
export async function claimRun(db: D1Client, { kind, game, fromCursor, now, workflowInstanceId }: ClaimOptions): Promise<Claim> {
	const cursorFrom = fromCursor ?? await storedCursor(db, kind, game);
	const seed = cursorFrom === FIRST_CURSOR && !(await holdsPrintings(db, game));
	const runId = newId();
	const [, inserted] = await db.batch([
		db.prepare(`UPDATE sync_run SET status = 'abandoned', error = ?1, finished_at = ?2, updated_at = ?2 WHERE kind = ?3 AND status = 'running' AND updated_at < ?4`)
			.bind(`abandoned: no progress for ${STALE_RUNNING_AFTER_MS} ms`, now, kind, now - STALE_RUNNING_AFTER_MS),
		db.prepare(`INSERT INTO sync_run (id, kind, game_system, status, cursor_from, cursor_to, records_seen, printings_seen, records_written, records_quarantined, records_drifted, error, workflow_instance_id, started_at, updated_at, finished_at)`
			+ ` SELECT ?1, ?2, ?3, 'running', ?4, ?4, 0, 0, 0, 0, 0, NULL, ?5, ?6, ?6, NULL`
			+ ` WHERE NOT EXISTS (SELECT 1 FROM sync_run WHERE kind = ?2 AND status = 'running')`)
			.bind(runId, kind, game, cursorFrom, workflowInstanceId ?? null, now),
	]);
	if (inserted!.meta.changes === 1) {
		return { claimed: true, runId, cursorFrom, seed };
	}
	const own = workflowInstanceId === undefined
		? null
		: await db
				.prepare(`SELECT id, cursor_from FROM sync_run WHERE kind = ?1 AND status = 'running' AND workflow_instance_id = ?2`)
				.bind(kind, workflowInstanceId)
				.first<{ id: string; cursor_from: Cursor }>();
	if (own) {
		return { claimed: true, runId: own.id, cursorFrom: own.cursor_from, seed };
	}
	return { claimed: false, reason: 'running' };
}

async function holdsPrintings(db: D1Client, game: string): Promise<boolean> {
	const row = await db.prepare(`SELECT EXISTS (SELECT 1 FROM printing WHERE game_system = ?1) AS held`).bind(game).first<{ held: number }>();
	return row?.held === 1;
}

export interface PageOptions extends RunRef {
	cursor: Cursor;
	fullWalk: boolean;
	now: number;
}

export interface PageResult {
	nextCursor: Cursor;
	hasMore: boolean;
}

/**
 * Pulls one page, judges it against the Mirror, applies it as one
 * `batch()`. The run's progress row is the batch's last statement; when it
 * changes nothing the page was already applied (a replay) or the run lost
 * the lock, and only the second is an error.
 */
export async function syncPage(db: D1Client, client: CatalogueClient, options: PageOptions): Promise<PageResult> {
	const page = await client.walkCatalogue(options.game, options.cursor);
	const existing = await readExisting(db, options.game, page.records.flatMap(r => (r.ok && r.record.kind === 'printing' ? [r.record.id] : [])));
	const plan = await planPage(page.records, existing, { fullWalk: options.fullWalk });
	const statements = pageStatements(plan, { ...options, nextCursor: page.nextCursor, newId });
	const results = await db.batch(statements.map(sql => db.prepare(sql)));
	if (results.at(-1)!.meta.changes === 0) {
		await assertRunning(db, options.runId);
	}
	if (plan.quarantined.length > 0) {
		console.warn(`[catalogue sync] ${options.game}: quarantined ${plan.quarantined.length} record(s) at cursor ${options.cursor}:`, plan.quarantined.map(q => `${q.recordKind ?? '?'} ${q.recordId ?? '?'} (${q.reason})`).join(', '));
	}
	return { nextCursor: page.nextCursor, hasMore: page.hasMore };
}

async function assertRunning(db: D1Client, runId: string): Promise<void> {
	const run = await readRun(db, runId);
	if (run.status !== 'running') {
		throw new Error(`sync_run ${runId} is ${run.status}; the lock was lost`);
	}
}

/** Hash and cursor of every row the page could touch, read in one `batch()`. */
async function readExisting(db: D1Client, game: string, printingIds: string[]): Promise<Existing> {
	const existing = emptyExisting();
	const selects = [
		`SELECT code AS key, content_hash AS hash, cursor FROM catalogue_set WHERE game_system = ${literal(game)}`,
		`SELECT facet, code, content_hash AS hash, cursor FROM catalogue_vocabulary WHERE game_system = ${literal(game)}`,
		...packRows('SELECT printing_id AS key, content_hash AS hash, cursor FROM printing_detail WHERE printing_id IN (', printingIds.map(literal), ')'),
	];
	const [sets, vocabularies, ...printings] = await db.batch<{ key: string; facet: string; code: string; hash: string; cursor: Cursor }>(selects.map(sql => db.prepare(sql)));
	const held = (row: { hash: string; cursor: Cursor }): ExistingRow => ({ hash: row.hash, cursor: row.cursor });
	for (const row of sets!.results) {
		existing.sets.set(row.key, held(row));
	}
	for (const row of vocabularies!.results) {
		existing.vocabularies.set(vocabularyKey(row.facet, row.code), held(row));
	}
	for (const row of printings.flatMap(result => result.results)) {
		existing.printings.set(row.key, held(row));
	}
	return existing;
}

export interface FinishOptions extends RunRef {
	fullWalk: boolean;
	seed: boolean;
	now: number;
}

/**
 * Settles the run. A full walk counts the Printings the Mirror holds that
 * the walk did not return as drift, rows untouched (absence is not
 * withdrawal, ADR 0009), and clears the quarantine earlier runs left. The
 * status follows the counts. The Mirror indexes are built here unless the
 * run was a seed, when they wait for the next run so every Game System
 * seeds bare (spec §4.5).
 */
export async function finishRun(db: D1Client, { runId, kind, game, fullWalk, seed, now }: FinishOptions): Promise<SyncRunSummary> {
	const row = await readRun(db, runId);
	const absent = fullWalk ? await absentPrintings(db, game, row.printingsSeen) : 0;
	if (absent > 0) {
		console.warn(`[catalogue sync] ${game}: the Mirror holds ${absent} Printing(s) the full walk did not return; recorded as drift, rows untouched`);
	}
	const drifted = row.counts.drifted + absent;
	const status: SyncRunStatus = row.counts.quarantined > 0 || drifted > 0 ? 'completed_with_drift' : 'completed';
	const [, finished] = await db.batch([
		fullWalk
			? db.prepare(`DELETE FROM catalogue_quarantine WHERE kind = ?1 AND game_system = ?2 AND sync_run_id <> ?3`).bind(kind, game, runId)
			: db.prepare(`SELECT 1`),
		db.prepare(`UPDATE sync_run SET status = ?1, records_drifted = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?4 AND status = 'running'`).bind(status, drifted, now, runId),
		...(seed ? [] : MIRROR_INDEXES.map(sql => db.prepare(sql))),
	]);
	if (finished!.meta.changes === 0) {
		await assertRunning(db, runId);
	}
	const { printingsSeen: _seen, ...summary } = await readRun(db, runId);
	return summary;
}

/** Printings of the Game System the Mirror holds beyond those a full walk returned. */
async function absentPrintings(db: D1Client, game: string, printingsSeen: number): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS held FROM printing WHERE game_system = ?1`).bind(game).first<{ held: number }>();
	return Math.max(0, (row?.held ?? 0) - printingsSeen);
}

/** Builds the Mirror indexes; a no-op once they exist. The seed script calls it after every Game System is in. */
export async function buildMirrorIndexes(db: D1Client): Promise<void> {
	await db.batch(MIRROR_INDEXES.map(sql => db.prepare(sql)));
}

export async function failRun(db: D1Client, { runId, now, error }: { runId: string; now: number; error: string }): Promise<void> {
	await db
		.prepare(`UPDATE sync_run SET status = 'failed', error = ?1, finished_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'running'`)
		.bind(error, now, runId)
		.run();
}

interface SyncRunRow {
	id: string;
	kind: SyncKind;
	game_system: string;
	status: SyncRunStatus;
	cursor_from: Cursor;
	cursor_to: Cursor;
	records_seen: number;
	printings_seen: number;
	records_written: number;
	records_quarantined: number;
	records_drifted: number;
}

async function readRun(db: D1Client, runId: string): Promise<SyncRunSummary & { printingsSeen: number }> {
	const row = await db
		.prepare(`SELECT id, kind, game_system, status, cursor_from, cursor_to, records_seen, printings_seen, records_written, records_quarantined, records_drifted FROM sync_run WHERE id = ?1`)
		.bind(runId)
		.first<SyncRunRow>();
	if (!row) {
		throw new Error(`sync_run ${runId} does not exist`);
	}
	return {
		id: row.id,
		kind: row.kind,
		gameSystem: row.game_system,
		status: row.status,
		cursorFrom: row.cursor_from,
		cursorTo: row.cursor_to,
		counts: { seen: row.records_seen, written: row.records_written, quarantined: row.records_quarantined, drifted: row.records_drifted },
		printingsSeen: row.printings_seen,
	};
}

/** How the run's stages execute: a Workflow makes each a durable step; a script runs them inline. */
export interface StepRunner {
	do: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

export const inlineSteps: StepRunner = { do: (_name, fn) => fn() };

export interface SyncOptions {
	/** The D1 binding; the run opens its own Session on it. */
	db: D1Database;
	client: CatalogueClient;
	game: string;
	/** Omit to resume from the stored cursor; `FIRST_CURSOR` seeds or reconciles. */
	fromCursor?: Cursor;
	now?: () => number;
	steps?: StepRunner;
	workflowInstanceId?: string;
}

/** The whole Catalogue run for one Game System: claim, every page, finish. */
export async function runCatalogueSync({ db: binding, client, game, fromCursor, now = Date.now, steps = inlineSteps, workflowInstanceId }: SyncOptions): Promise<SyncOutcome> {
	const kind: SyncKind = 'catalogue';
	const db: D1Client = binding.withSession('first-primary');
	const claim = await steps.do('claim', () => claimRun(db, { kind, game, fromCursor, now: now(), workflowInstanceId }));
	if (!claim.claimed) {
		return claim;
	}
	const { runId, cursorFrom, seed } = claim;
	const ref: RunRef = { runId, kind, game };
	const fullWalk = cursorFrom === FIRST_CURSOR;
	try {
		let cursor = cursorFrom;
		for (let n = 1; ; n += 1) {
			const page = await steps.do(`page ${n}`, () => syncPage(db, client, { ...ref, cursor, fullWalk, now: now() }));
			cursor = page.nextCursor;
			if (!page.hasMore) {
				break;
			}
		}
		const run = await steps.do('finish', () => finishRun(db, { ...ref, fullWalk, seed, now: now() }));
		return { claimed: true, run };
	}
	catch (error) {
		await steps.do('fail', () => failRun(db, { runId, now: now(), error: error instanceof Error ? error.message : String(error) }));
		throw error;
	}
}
