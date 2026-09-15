import type { Db } from '../../server/db/client';
import type { Actor } from '../../server/ledger/actor';
import { asc, eq } from 'drizzle-orm';
import { ledgerLine, printing } from '../../server/db/schema';

/** A Mirror row for a test to hold stock against; the Catalogue's shape, one Pokémon Pikachu by default. */
export async function seedPrinting(db: Db, overrides: Partial<typeof printing.$inferInsert> = {}) {
	const row: typeof printing.$inferInsert = {
		id: 'prt-pokemon-base1-58',
		cardId: 'card-pokemon-pikachu',
		gameSystem: 'pokemon',
		name: 'Pikachu',
		setCode: 'base1',
		collectorNumber: '58',
		rarity: 'common',
		finish: null,
		images: '[]',
		withdrawn: false,
		cursor: 'pokemon-0001',
		syncedAt: 1_789_084_800_000,
		...overrides,
	};
	await db.insert(printing).values(row);
	return row;
}

/** The shared store login's session, as the surface middleware would place it on the request. */
export const STAFF_ACTOR: Actor = { surface: 'staff', sessionId: 'sess_counter_1', staffUserId: null };

/** The SKU most stock tests hold: the default Printing, Near Mint, English. */
export const PIKACHU_NM = { printingId: 'prt-pokemon-base1-58', condition: 'NM', language: 'en' } as const;

/** An entry's lines, stock out before stock in. */
export function linesOf(db: Db, entryId: string) {
	return db.select().from(ledgerLine).where(eq(ledgerLine.entryId, entryId)).orderBy(asc(ledgerLine.quantity));
}
