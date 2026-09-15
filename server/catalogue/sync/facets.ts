/**
 * What the sync knows about a Game System's Facets, until the Game System
 * modules (spec §4.2, _Per-Game-System search tables_; ADR 0008) own it.
 *
 * A multi-valued Facet (colour identity, colour, domain) is one boolean
 * column per value on the game's search table, so a value with no column
 * cannot be written: the record is quarantined and the run completes
 * `completed_with_drift`, to be re-read once the release with the column
 * lands (ADR 0009). Every other attribute value passes through as text.
 */
import type { PrintingRecord } from '../generated/types.gen';

/** Per game, the multi-valued Facets and the values shop-keepr has a column for. */
export const COLUMN_BACKED_FACETS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
	magic: { colour_identity: ['W', 'U', 'B', 'R', 'G'] },
};

/** Per game, the attribute that names a Printing's finish or variant for display. */
const FINISH_ATTRIBUTE: Readonly<Record<string, string>> = {
	magic: 'finish',
	pokemon: 'variant',
};

export type FacetJudgement = { ok: true } | { ok: false; facet: string; value: unknown };

/** Whether every column-backed Facet value on the record has a column. */
export function judgeFacets(record: PrintingRecord): FacetJudgement {
	const facets = COLUMN_BACKED_FACETS[record.game] ?? {};
	for (const [facet, known] of Object.entries(facets)) {
		const value = record.attributes[facet];
		if (value === undefined || value === null) {
			continue;
		}
		if (!Array.isArray(value)) {
			return { ok: false, facet, value };
		}
		const unknown = value.find(code => !known.includes(code));
		if (unknown !== undefined) {
			return { ok: false, facet, value: unknown };
		}
	}
	return { ok: true };
}

/** The finish or variant code shown beside a Printing, or null. */
export function displayFinish(record: PrintingRecord): string | null {
	const attribute = FINISH_ATTRIBUTE[record.game];
	const value = attribute === undefined ? undefined : record.attributes[attribute];
	return typeof value === 'string' ? value : null;
}
