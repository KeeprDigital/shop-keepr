/**
 * The search read model's write side (spec §4.2; §5, _Write shape_; ADR
 * 0008, ADR 0012): what the Catalogue sync calls so that every Printing
 * record lands on its game's search table, in that table's FTS5 index and
 * in the trigram vocabulary within the same page `batch()`. This is the
 * only code that writes a per-game table; the sync knows only this file.
 *
 * An external-content FTS5 index does not follow its base table: a
 * renamed Printing left the index matching the old name, silently (#13).
 * So every page deletes the index rows of the Printings it is about to
 * rewrite, upserts the search rows, then reinserts from the rows as they
 * now stand. The vocabulary only ever grows: a token no name carries any
 * more resolves to nothing at tier 5.
 */
import type { PrintingRecord } from '../catalogue/generated/types.gen';
import { foldTokens, NAME_KEYS_VERSION, tokenTrigrams } from '../../shared/search/name-keys';
import { literal, packRows, tuple } from '../db/sql';
import { GAME_SYSTEMS, gameSystem, searchColumns, searchRow, UnknownFacetValue } from './games';

export type FacetJudgement = { ok: true } | { ok: false; facet: string; value: unknown };

/** Whether every multi-valued Facet value on the record has a column on its game's search table; a game with no module has nothing to judge. */
export function judgeFacets(record: PrintingRecord): FacetJudgement {
	const module = gameSystem(record.game);
	if (!module) {
		return { ok: true };
	}
	try {
		searchRow(module, record, { now: 0 });
		return { ok: true };
	}
	catch (error) {
		if (error instanceof UnknownFacetValue) {
			return { ok: false, facet: error.facet, value: error.value };
		}
		throw error;
	}
}

/**
 * A SQL predicate on `printing_detail`: the Printing's search row exists,
 * written under the current name-key rule. The sync counts a Printing as
 * held only when this holds, so a search table added to a Mirror that
 * already holds the game, or a bump of `NAME_KEYS_VERSION`, is repaired
 * by the next full walk with no Catalogue change and no special run.
 * Always true for a game with no module.
 */
export function heldInSearch(game: string): string {
	const module = gameSystem(game);
	if (!module) {
		return '1';
	}
	return `EXISTS (SELECT 1 FROM ${module.table} s WHERE s.id = printing_detail.printing_id AND s.keys_version = ${NAME_KEYS_VERSION})`;
}

/**
 * The statements that put `records` on the search table of `game`, in the
 * order the batch must run them; none for a game shop-keepr has no module
 * for. Run after the `printing` upsert: the search row's Market Price is
 * read back from `printing`, so the two copies cannot disagree.
 */
export function searchStatements(game: string, records: readonly PrintingRecord[], { now }: { now: number }): string[] {
	const module = gameSystem(game);
	if (!module || records.length === 0) {
		return [];
	}
	const fts = `${module.table}_fts`;
	const ids = records.map(r => literal(r.id));
	const columns = searchColumns(module);
	const rows = records.map(record => searchRow(module, record, { now }));
	const updates = columns
		.filter(c => c !== 'id')
		.map(c => (c === 'market_price' ? `market_price = (SELECT market_price FROM printing WHERE printing.id = excluded.id)` : `${c} = excluded.${c}`))
		.join(', ');
	return [
		...packRows(`INSERT INTO ${fts}(${fts}, rowid, name_folded, name_metaphone) SELECT 'delete', rowid, name_folded, name_metaphone FROM ${module.table} WHERE id IN (`, ids, ')'),
		...packRows(
			`INSERT INTO ${module.table} (${columns.join(', ')}) VALUES `,
			rows.map(row => tuple(columns.map(c => row[c] ?? null))),
			` ON CONFLICT(id) DO UPDATE SET ${updates} WHERE excluded.cursor >= ${module.table}.cursor`,
		),
		...packRows(`INSERT INTO ${fts}(rowid, name_folded, name_metaphone) SELECT rowid, name_folded, name_metaphone FROM ${module.table} WHERE id IN (`, ids, ')'),
		...packRows('INSERT OR IGNORE INTO token_trigram (trigram, token) VALUES ', vocabularyRows(records), ''),
	];
}

/** Every (trigram, token) of the records' names, once. */
function vocabularyRows(records: readonly PrintingRecord[]): string[] {
	const tokens = new Set(records.flatMap(r => foldTokens(r.name)));
	return [...tokens].flatMap(token => tokenTrigrams(token).map(trigram => tuple([trigram, token])));
}

/**
 * Each search table's index set (spec §4.2, Open: the exact set), built
 * by the run's finish step beside the Mirror's: the two exact tiers, the
 * set-and-number lookup, and the Card grouping. The FTS5 index and the
 * vocabulary's primary key are in the migration, since pages write them.
 */
export const SEARCH_INDEXES: readonly string[] = GAME_SYSTEMS.flatMap(({ table }) => [
	`CREATE INDEX IF NOT EXISTS ${table}_folded ON ${table} (name_folded)`,
	`CREATE INDEX IF NOT EXISTS ${table}_folded_nospace ON ${table} (name_folded_nospace)`,
	`CREATE INDEX IF NOT EXISTS ${table}_set_number ON ${table} (set_code, collector_number)`,
	`CREATE INDEX IF NOT EXISTS ${table}_card ON ${table} (card_id)`,
]);
