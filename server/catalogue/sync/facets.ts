/**
 * The display-side reading of a Printing's attributes. Which attributes
 * are Facets, and what happens to a value with no column, is the Game
 * System module's business (`server/search/games`; ADR 0008): the sync
 * asks `server/search/mirror.ts` to judge and to write.
 */
import type { PrintingRecord } from '../generated/types.gen';

/** Per game, the attribute that names a Printing's finish or variant for display. */
const FINISH_ATTRIBUTE: Readonly<Record<string, string>> = {
	magic: 'finish',
	pokemon: 'variant',
};

/** The finish or variant code shown beside a Printing, or null. */
export function displayFinish(record: PrintingRecord): string | null {
	const attribute = FINISH_ATTRIBUTE[record.game];
	const value = attribute === undefined ? undefined : record.attributes[attribute];
	return typeof value === 'string' ? value : null;
}
