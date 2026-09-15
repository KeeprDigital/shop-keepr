/**
 * The judgement half of a page (spec §5, _Write shape_; ADR 0009), kept
 * free of D1 so it is unit-testable against the fixture: given the parsed
 * records of one page and what the Mirror already holds for them, decide
 * what to write, what to skip, what to quarantine, and what counts as drift.
 *
 * - Hash match is a read, not a write, which is what lets seed, delta and
 *   reconcile share one code path.
 * - A record applies only if its cursor is at or after the stored one.
 * - A hash mismatch on a full walk is drift, counted and recorded.
 * - A Printing whose search row is missing or outdated is written again
 *   whatever its hash, and that is not drift (ADR 0008).
 * - A record that fails validation, or needs a column that does not exist,
 *   is quarantined with its raw payload; the run never fails.
 * - Sets and vocabularies come before Printings.
 */
import type { QuarantineReason } from '../../../shared/domain/sync-run';
import type { ParsedRecord } from '../client';
import type { CatalogueRecord, Cursor, PrintingRecord, SetRecord, VocabularyRecord } from '../generated/types.gen';
import { judgeFacets } from '../../search/mirror';
import { contentHash } from './hash';

export interface ExistingRow {
	hash: string;
	cursor: Cursor;
	/**
	 * Printings only: whether the game's search row exists at the current
	 * name-key version (ADR 0008). False makes the record a write whatever
	 * its hash says; it is never drift, which is the Catalogue disagreeing
	 * with the Mirror, not the Mirror owing itself a derived row.
	 */
	searchHeld?: boolean;
}

/** What the Mirror holds for the records on this page, keyed as the tables are. */
export interface Existing {
	printings: Map<string, ExistingRow>;
	sets: Map<string, ExistingRow>;
	vocabularies: Map<string, ExistingRow>;
}

export function emptyExisting(): Existing {
	return { printings: new Map(), sets: new Map(), vocabularies: new Map() };
}

/** `catalogue_vocabulary` is keyed by (facet, code) within a Game System. */
export function vocabularyKey(facet: string, code: string): string {
	return `${facet}/${code}`;
}

export interface Write<T> {
	record: T;
	hash: string;
}

export interface Quarantined {
	reason: QuarantineReason;
	recordKind: string | null;
	recordId: string | null;
	cursor: Cursor | null;
	detail: unknown;
	raw: unknown;
}

/** The counts `sync_run` accumulates over a run. */
export interface PageCounts {
	seen: number;
	written: number;
	quarantined: number;
	drifted: number;
	/** Market Price runs only: movements left unapplied because the Mirror lacks the Printing or the rate was null. */
	skipped: number;
}

export interface PagePlan {
	sets: Write<SetRecord>[];
	vocabularies: Write<VocabularyRecord>[];
	printings: Write<PrintingRecord>[];
	quarantined: Quarantined[];
	counts: PageCounts;
	/** Printing records on the page, applied or quarantined: what a full walk returned of the Mirror's rows. */
	printingsSeen: number;
}

export interface PlanOptions {
	/** A walk from cursor zero: a seed or a reconcile, where a mismatch on a held row is drift. */
	fullWalk: boolean;
}

export async function planPage(records: ParsedRecord<CatalogueRecord>[], existing: Existing, { fullWalk }: PlanOptions): Promise<PagePlan> {
	const plan: PagePlan = {
		sets: [],
		vocabularies: [],
		printings: [],
		quarantined: [],
		counts: { seen: records.length, written: 0, quarantined: 0, drifted: 0, skipped: 0 },
		printingsSeen: 0,
	};

	async function consider<T extends CatalogueRecord>(record: T, held: ExistingRow | undefined, writes: Write<T>[]) {
		if (held && record.cursor < held.cursor) {
			return;
		}
		const hash = await contentHash(record);
		if (held?.hash === hash && held.searchHeld !== false) {
			return;
		}
		writes.push({ record, hash });
		plan.counts.written += 1;
		if (held && fullWalk && held.hash !== hash) {
			plan.counts.drifted += 1;
		}
	}

	function quarantine(raw: unknown, reason: QuarantineReason, detail: unknown) {
		const entry = quarantined(raw, reason, detail);
		plan.quarantined.push(entry);
		plan.counts.quarantined += 1;
		if (entry.recordKind === 'printing') {
			plan.printingsSeen += 1;
		}
	}

	for (const parsed of records) {
		if (!parsed.ok) {
			quarantine(parsed.raw, 'validation_failed', { issues: parsed.issues });
			continue;
		}
		const record = parsed.record;
		switch (record.kind) {
			case 'set':
				await consider(record, existing.sets.get(record.code), plan.sets);
				break;
			case 'vocabulary':
				await consider(record, existing.vocabularies.get(vocabularyKey(record.facet, record.code)), plan.vocabularies);
				break;
			case 'printing': {
				const judgement = judgeFacets(record);
				if (!judgement.ok) {
					quarantine(record, 'unknown_facet_value', { facet: judgement.facet, value: judgement.value });
					break;
				}
				plan.printingsSeen += 1;
				await consider(record, existing.printings.get(record.id), plan.printings);
			}
		}
	}
	return plan;
}

/** A payload the run could not apply, described by whatever it says about itself. */
export function quarantined(raw: unknown, reason: QuarantineReason, detail: unknown): Quarantined {
	return { reason, ...selfDescription(raw), detail, raw };
}

/** What a payload says about itself, when it is an object that says anything. */
function selfDescription(raw: unknown): Pick<Quarantined, 'recordKind' | 'recordId' | 'cursor'> {
	const field = (name: string): string | null => {
		const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : undefined;
		return typeof value === 'string' ? value : null;
	};
	return { recordKind: field('kind'), recordId: field('id') ?? field('printing_id') ?? field('code'), cursor: field('cursor') };
}
