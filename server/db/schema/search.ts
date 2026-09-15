import type { SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { GAME_SYSTEMS, searchColumns } from '../../search/games';
import { epochMs } from '../columns';

/**
 * The search read model (spec §4.2, _Per-Game-System search tables_; §4.3;
 * ADR 0008, ADR 0012): one table per Game System, built from its module,
 * carrying the name keys, the sort keys, the Market Price a second time
 * and that game's typed Facet columns, so a game-scoped filter and sort is
 * one index. Read only by search; written only by the sync through the
 * search module's write side. Each table's FTS5 index is declared by hand
 * in the migration, since drizzle-kit knows no virtual tables, and its
 * index set is built by the run's finish step (`server/search/mirror.ts`).
 * This file is the one place outside `server/search` that reads the
 * registry, and only to declare the tables for drizzle-kit; it names no
 * game of its own.
 */

/** The columns every search table shares, by name. */
function sharedColumns(): Record<string, SQLiteColumnBuilderBase> {
	return {
		/** The Catalogue's Printing id, verbatim; joins `printing` for display. */
		id: text().primaryKey(),
		card_id: text().notNull(),
		name: text().notNull(),
		/** `fold(name)`: tier 1, and what the FTS5 index tokenises. */
		name_folded: text().notNull(),
		/** `foldNoSpace(name)`: tier 2. */
		name_folded_nospace: text().notNull(),
		/** `metaphoneKey(name)`: tier 4, through the same FTS5 index. */
		name_metaphone: text().notNull(),
		set_code: text().notNull(),
		collector_number: text(),
		rarity: text(),
		/** A copy of `printing.market_price`, kept equal by the same batch. */
		market_price: integer({ mode: 'number' }),
		withdrawn: integer({ mode: 'boolean' }).notNull(),
		/** The name-key rule version the row was written under (`NAME_KEYS_VERSION`). */
		keys_version: integer({ mode: 'number' }).notNull(),
		cursor: text().notNull(),
		synced_at: epochMs().notNull(),
	};
}

/** One Drizzle table per module: the shared keys, then a text column per single-valued Facet and a flag per multi-valued Facet value. */
export const searchTables = Object.fromEntries(GAME_SYSTEMS.map((module) => {
	const columns = sharedColumns();
	const flags = new Set(module.facets.flatMap(f => (f.kind === 'flags' ? Object.values(f.columns) : [])));
	for (const column of searchColumns(module)) {
		if (!(column in columns)) {
			columns[column] = flags.has(column) ? integer({ mode: 'boolean' }).notNull() : text();
		}
	}
	return [module.table, sqliteTable(module.table, columns)];
}));

export const mtgPrinting = searchTables.mtg_printing!;
export const pokemonPrinting = searchTables.pokemon_printing!;
export const onepiecePrinting = searchTables.onepiece_printing!;
export const riftboundPrinting = searchTables.riftbound_printing!;

/**
 * Tier 5's vocabulary (spec §4.3.4): one row per (trigram, distinct folded
 * token) across every Game System, the token padded two spaces each side.
 * Per token, not per name or Printing, so it tracks vocabulary size. The
 * primary key is the covering index the measured query walks. Rows are
 * only ever added: a token no name carries any more resolves to nothing.
 */
export const tokenTrigram = sqliteTable('token_trigram', {
	trigram: text().notNull(),
	token: text().notNull(),
}, table => [
	primaryKey({ columns: [table.trigram, table.token] }),
]);
