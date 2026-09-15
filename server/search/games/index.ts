/**
 * The Game System registry (spec §4.2; ADR 0008) and the one projection
 * from a Catalogue record onto a search row. Only `server/search` imports
 * the modules; the sync reaches them through `../mirror.ts`.
 */
import type { PrintingRecord } from '../../catalogue/generated/types.gen';
import type { GameSystemModule } from './module';
import { fold, foldNoSpace, metaphoneKey, NAME_KEYS_VERSION } from '../../../shared/search/name-keys';
import { magic } from './magic';
import { SHARED_SEARCH_COLUMNS } from './module';
import { onepiece } from './onepiece';
import { pokemon } from './pokemon';
import { riftbound } from './riftbound';

export type { Facet, FlagFacet, GameSystemModule, TextFacet } from './module';

export const GAME_SYSTEMS: readonly GameSystemModule[] = [magic, pokemon, onepiece, riftbound];

export function gameSystem(game: string): GameSystemModule | undefined {
	return GAME_SYSTEMS.find(m => m.game === game);
}

/** Every column of the module's table, shared keys first, then Facet columns, then any Pricing Attribute column not already there. */
export function searchColumns(module: GameSystemModule): string[] {
	const columns: string[] = [...SHARED_SEARCH_COLUMNS];
	for (const facet of module.facets) {
		columns.push(...(facet.kind === 'text' ? [facet.column] : Object.values(facet.columns)));
	}
	for (const column of Object.values(module.pricingAttributes)) {
		if (!columns.includes(column)) {
			columns.push(column);
		}
	}
	return columns;
}

/** A search-table cell: text, an integer, a flag or null. */
export type SearchValue = string | number | boolean | null;

export class UnknownFacetValue extends Error {
	constructor(readonly facet: string, readonly value: unknown) {
		super(`Facet ${facet} has no column for value ${JSON.stringify(value)}`);
	}
}

/** The record projected onto the module's columns, in `searchColumns` order; throws `UnknownFacetValue` for a flag with no column. */
export function searchRow(module: GameSystemModule, record: PrintingRecord, { now }: { now: number }): Record<string, SearchValue> {
	const row: Record<string, SearchValue> = {
		id: record.id,
		card_id: record.card_id,
		name: record.name,
		name_folded: fold(record.name),
		name_folded_nospace: foldNoSpace(record.name),
		name_metaphone: metaphoneKey(record.name),
		set_code: record.set_code,
		collector_number: record.collector_number,
		rarity: record.rarity,
		market_price: record.market_price?.amount ?? null,
		withdrawn: record.withdrawn,
		keys_version: NAME_KEYS_VERSION,
		cursor: record.cursor,
		synced_at: now,
	};
	for (const facet of module.facets) {
		if (facet.kind === 'text') {
			row[facet.column] = textAttribute(record, facet.attribute);
			continue;
		}
		const values = record.attributes[facet.attribute];
		const listed = values ?? [];
		if (!Array.isArray(listed)) {
			throw new UnknownFacetValue(facet.facet, listed);
		}
		for (const value of listed) {
			if (!(value in facet.columns)) {
				throw new UnknownFacetValue(facet.facet, value);
			}
		}
		for (const [value, column] of Object.entries(facet.columns)) {
			row[column] = listed.includes(value);
		}
	}
	for (const [attribute, column] of Object.entries(module.pricingAttributes)) {
		if (!(column in row)) {
			row[column] = textAttribute(record, attribute);
		}
	}
	return row;
}

function textAttribute(record: PrintingRecord, attribute: string): string | null {
	const value = record.attributes[attribute];
	return typeof value === 'string' ? value : null;
}
