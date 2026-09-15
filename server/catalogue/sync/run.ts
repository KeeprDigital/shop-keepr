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
 * `cursor_to` of its latest run no longer running. The job takes a database
 * binding, never the database (tenancy hook), and a `StepRunner` so the
 * Workflow can make every page a durable step while a script runs the same
 * code inline.
 */
import type { SyncKind, SyncRunStatus } from '../../../shared/domain/sync-run';
import type { CatalogueClient } from '../client';
import type { Cursor } from '../generated/types.gen';
import type { Existing, PageCounts } from './plan';
import { newId } from '../../utils/ids';
import { FIRST_CURSOR } from '../client';
import { MIRROR_INDEXES } from './indexes';
import { emptyExisting, planPage, vocabularyKey } from './plan';
import { literal, packRows } from './sql';
import { pageStatements } from './statements';

/** What the sync needs of D1; a Session provides both. */
export type D1Client = Pick<D1Database, 'prepare' | 'batch'>;

/**
 * A `running` row not touched for this long is abandoned by the next claim:
 * 2x the expected duration of a run, a default chosen without a census
 * (spec §5, _Idempotency, ordering, lock_).
 */
export const STALE_RUNNING_AFTER_MS = 2 * 60 * 60 * 1_000;

export interface SyncRunSummary {
	id: string;
	kind: SyncKind;
	gameSystem: string;
	status: SyncRunStatus;
	cursorFrom: Cursor;
	cursorTo: Cursor;
	counts: PageCounts;
}

export type SyncOutcome
	= | { claimed: false; reason: 'running' }
		| { claimed: true; run: SyncRunSummary };

export interface ClaimOptions {
	kind: SyncKind;
	game: string;
	/** Omit to resume from the stored cursor; `FIRST_CURSOR` seeds or reconciles. */
	fromCursor?: Cursor;
	now: number;
	workflowInstanceId?: string;
}

export type Claim
	= | { claimed: false; reason: 'running' }
		| { claimed: true; runId: string; cursorFrom: Cursor };

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
	const runId = newId();
	const [, inserted] = await db.batch([
		db.prepare(`UPDATE sync_run SET status = 'abandoned', error = ?1, finished_at = ?2, updated_at = ?2 WHERE kind = ?3 AND status = 'running' AND updated_at < ?4`)
			.bind(`abandoned: no progress for ${STALE_RUNNING_AFTER_MS} ms`, now, kind, now - STALE_RUNNING_AFTER_MS),
		db.prepare(`INSERT INTO sync_run (id, kind, game_system, status, cursor_from, cursor_to, records_seen, records_written, records_quarantined, records_drifted, error, workflow_instance_id, started_at, updated_at, finished_at)`
			+ ` SELECT ?1, ?2, ?3, 'running', ?4, ?4, 0, 0, 0, 0, NULL, ?5, ?6, ?6, NULL`
			+ ` WHERE NOT EXISTS (SELECT 1 FROM sync_run WHERE kind = ?2 AND status = 'running')`)
			.bind(runId, kind, game, cursorFrom, workflowInstanceId ?? null, now),
	]);
	if (inserted!.meta.changes === 1) {
		return { claimed: true, runId, cursorFrom };
	}
	const holder = await db
		.prepare(`SELECT id, cursor_from FROM sync_run WHERE kind = ?1 AND status = 'running' AND workflow_instance_id IS ?2`)
		.bind(kind, workflowInstanceId ?? null)
		.first<{ id: string; cursor_from: Cursor }>();
	if (workflowInstanceId !== undefined && holder) {
		return { claimed: true, runId: holder.id, cursorFrom: holder.cursor_from };
	}
	return { claimed: false, reason: 'running' };
}

export interface PageOptions {
	runId: string;
	kind: SyncKind;
	game: string;
	cursor: Cursor;
	fullWalk: boolean;
	now: number;
}

export interface PageResult {
	nextCursor: Cursor;
	hasMore: boolean;
}

/** Pulls one page, judges it against the Mirror, applies it as one `batch()`. */
export async function syncPage(db: D1Client, client: CatalogueClient, options: PageOptions): Promise<PageResult> {
	const page = await client.walkCatalogue(options.game, options.cursor);
	const existing = await readExisting(db, options.game, page.records.flatMap(r => (r.ok && r.record.kind === 'printing' ? [r.record.id] : [])));
	const plan = await planPage(page.records, existing, { fullWalk: options.fullWalk });
	const statements = pageStatements(plan, { ...options, nextCursor: page.nextCursor, newId });
	await db.batch(statements.map(sql => db.prepare(sql)));
	return { nextCursor: page.nextCursor, hasMore: page.hasMore };
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
	for (const row of sets!.results) {
		existing.sets.set(row.key, { hash: row.hash, cursor: row.cursor });
	}
	for (const row of vocabularies!.results) {
		existing.vocabularies.set(vocabularyKey(row.facet, row.code), { hash: row.hash, cursor: row.cursor });
	}
	for (const row of printings.flatMap(result => result.results)) {
		existing.printings.set(row.key, { hash: row.hash, cursor: row.cursor });
	}
	return existing;
}

export interface FinishOptions {
	runId: string;
	kind: SyncKind;
	game: string;
	fullWalk: boolean;
	now: number;
}

/**
 * Settles the run's status from its counts, clears the quarantine earlier
 * runs left when this was a full walk, and builds the Mirror indexes, which
 * wait until after a seed because each multiplies the writes per Printing
 * (spec §4.5).
 */
export async function finishRun(db: D1Client, { runId, kind, game, fullWalk, now }: FinishOptions): Promise<SyncRunSummary> {
	const row = await readRun(db, runId);
	const status: SyncRunStatus = row.counts.quarantined > 0 || row.counts.drifted > 0 ? 'completed_with_drift' : 'completed';
	await db.batch([
		...(fullWalk
			? [db.prepare(`DELETE FROM catalogue_quarantine WHERE kind = ?1 AND game_system = ?2 AND sync_run_id <> ?3`).bind(kind, game, runId)]
			: []),
		db.prepare(`UPDATE sync_run SET status = ?1, finished_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'running'`).bind(status, now, runId),
		...MIRROR_INDEXES.map(sql => db.prepare(sql)),
	]);
	return { ...row, status };
}

export async function failRun(db: D1Client, { runId, now, error }: { runId: string; now: number; error: string }): Promise<void> {
	await db
		.prepare(`UPDATE sync_run SET status = 'failed', error = ?1, finished_at = ?2, updated_at = ?2 WHERE id = ?3 AND status = 'running'`)
		.bind(error, now, runId)
		.run();
}

export async function readRun(db: D1Client, runId: string): Promise<SyncRunSummary> {
	const row = await db
		.prepare(`SELECT id, kind, game_system, status, cursor_from, cursor_to, records_seen, records_written, records_quarantined, records_drifted FROM sync_run WHERE id = ?1`)
		.bind(runId)
		.first<{ id: string; kind: SyncKind; game_system: string; status: SyncRunStatus; cursor_from: Cursor; cursor_to: Cursor; records_seen: number; records_written: number; records_quarantined: number; records_drifted: number }>();
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
	const { runId, cursorFrom } = claim;
	const fullWalk = cursorFrom === FIRST_CURSOR;
	try {
		let cursor = cursorFrom;
		for (let n = 1; ; n += 1) {
			const page = await steps.do(`page ${n}`, () => syncPage(db, client, { runId, kind, game, cursor, fullWalk, now: now() }));
			cursor = page.nextCursor;
			if (!page.hasMore) {
				break;
			}
		}
		const run = await steps.do('finish', () => finishRun(db, { runId, kind, game, fullWalk, now: now() }));
		return { claimed: true, run };
	}
	catch (error) {
		await steps.do('fail', () => failRun(db, { runId, now: now(), error: error instanceof Error ? error.message : String(error) }));
		throw error;
	}
}
