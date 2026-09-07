/**
 * Throwaway spike schema (issue #13).
 *
 * Shaped after the decision in issue #6: the Catalogue mirror is namespaced
 * separately from store-owned tables, and `store_id` sits on every store-owned
 * table. Prices are integer pence; timestamps are epoch-ms integers, per #2.
 *
 * One statement per array entry so it can be fed to `D1Database.exec()`, which
 * splits input on newlines.
 */

/** The Catalogue mirror plus the store's own stock. No indexes yet — those are applied separately so their cost can be measured. */
export const BASE_SCHEMA = [
	'DROP TABLE IF EXISTS stock;',
	'DROP TABLE IF EXISTS catalogue_printing;',
	[
		'CREATE TABLE catalogue_printing (',
		'id TEXT PRIMARY KEY,',
		'game_system TEXT NOT NULL,',
		'name TEXT NOT NULL,',
		'set_code TEXT NOT NULL,',
		'set_name TEXT NOT NULL,',
		'collector_number TEXT NOT NULL,',
		'rarity TEXT NOT NULL,',
		'finish TEXT NOT NULL,',
		'language TEXT NOT NULL,',
		'colour_identity TEXT,',
		'type_line TEXT,',
		'subtype TEXT,',
		'mana_value INTEGER,',
		'market_price INTEGER,',
		'image_uri TEXT NOT NULL,',
		'released_at INTEGER NOT NULL',
		') STRICT;',
	].join(' '),
	[
		'CREATE TABLE stock (',
		'id INTEGER PRIMARY KEY AUTOINCREMENT,',
		'store_id TEXT NOT NULL,',
		'printing_id TEXT NOT NULL,',
		'condition TEXT NOT NULL,',
		'quantity INTEGER NOT NULL,',
		'sell_price INTEGER NOT NULL,',
		'buy_price INTEGER NOT NULL',
		') STRICT;',
	].join(' '),
].join('\n');

/** Indexes a faceted storefront search would plausibly want. Applied after the bulk load, as a real seed would. */
export const INDEXES = [
	// Facet entry point: every storefront query is game-scoped (#6 constraint 5).
	'CREATE INDEX cp_game_rarity ON catalogue_printing (game_system, rarity, name);',
	'CREATE INDEX cp_game_colour ON catalogue_printing (game_system, colour_identity, rarity);',
	'CREATE INDEX cp_game_set ON catalogue_printing (game_system, set_code, collector_number);',
	'CREATE INDEX cp_name ON catalogue_printing (name);',
	// Store-owned side.
	'CREATE UNIQUE INDEX stock_sku ON stock (store_id, printing_id, condition);',
	'CREATE INDEX stock_price ON stock (store_id, sell_price);',
	'CREATE INDEX stock_printing ON stock (printing_id);',
];

/** A partial index scoped to one Game System, to test whether the planner picks it up. */
export const PARTIAL_INDEX
	= 'CREATE INDEX cp_magic_rarity_partial ON catalogue_printing (rarity, colour_identity, mana_value) WHERE game_system = \'magic\';';

/** A covering index over exactly the columns the faceted browse query touches. */
export const COVERING_INDEX
	= 'CREATE INDEX cp_facet_covering ON catalogue_printing (game_system, rarity, colour_identity, name, set_code, market_price);';

/** Denormalised copy of the two facet columns onto the store-owned side, so the sort can be driven entirely from `stock`. */
export const DENORM = [
	'DROP TABLE IF EXISTS stock_denorm;',
	[
		'CREATE TABLE stock_denorm (',
		'id INTEGER PRIMARY KEY,',
		'store_id TEXT NOT NULL,',
		'printing_id TEXT NOT NULL,',
		'condition TEXT NOT NULL,',
		'quantity INTEGER NOT NULL,',
		'sell_price INTEGER NOT NULL,',
		'game_system TEXT NOT NULL,',
		'rarity TEXT NOT NULL,',
		'colour_identity TEXT',
		') STRICT;',
	].join(' '),
].join('\n');

export const DENORM_INDEX
	= 'CREATE INDEX sd_facet ON stock_denorm (store_id, game_system, rarity, colour_identity, sell_price);';
