/**
 * What a Game System module declares (spec §4.2, _Per-Game-System search
 * tables_; ADR 0008): its search table, its typed Facet columns beyond
 * the set and rarity every table has, and its Pricing Attribute registry.
 * Search is the only code that reads a per-game table, and the search
 * module's write side (`../mirror.ts`) is the only code that writes one.
 * Adding a Game System is a module here, a registry entry and a migration.
 */

/** A single-valued Facet: one text column holding the attribute's code. */
export interface TextFacet {
	kind: 'text';
	facet: string;
	/** The Catalogue attribute key the value is read from. */
	attribute: string;
	column: string;
}

/**
 * A multi-valued Facet (colour identity, colour, domain): one boolean
 * column per value, filter semantics _contains_. A value with no column
 * cannot be written, so the sync quarantines the record (ADR 0009).
 */
export interface FlagFacet {
	kind: 'flags';
	facet: string;
	attribute: string;
	/** Value code → column. */
	columns: Readonly<Record<string, string>>;
}

export type Facet = TextFacet | FlagFacet;

export interface GameSystemModule {
	/** The Catalogue's game code, as `printing.game_system` carries it. */
	game: string;
	table: string;
	/** Facets beyond set and rarity, in the spec's order. */
	facets: readonly Facet[];
	/**
	 * The closed registry of attribute keys Pricing Rules may key on →
	 * the column on the search table. Settings offer only these; `rarity`
	 * is on every game. A key that is not a Facet still gets a text column.
	 */
	pricingAttributes: Readonly<Record<string, string>>;
}

/** The column shared keys every search table carries before its Facet columns. */
export const SHARED_SEARCH_COLUMNS = [
	'id',
	'card_id',
	'name',
	'name_folded',
	'name_folded_nospace',
	'name_metaphone',
	'set_code',
	'collector_number',
	'rarity',
	'market_price',
	'withdrawn',
	/** The `NAME_KEYS_VERSION` the name keys were computed under; a bump makes the next full walk rewrite the row. */
	'keys_version',
	'cursor',
	'synced_at',
] as const;

export function textFacet(facet: string, attribute = facet, column = facet): TextFacet {
	return { kind: 'text', facet, attribute, column };
}

export function flagFacet(facet: string, values: readonly string[], columnOf: (value: string) => string, attribute = facet): FlagFacet {
	return { kind: 'flags', facet, attribute, columns: Object.fromEntries(values.map(value => [value, columnOf(value)])) };
}
