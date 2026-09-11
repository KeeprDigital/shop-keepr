/**
 * Condition: the physical grade of a SKU. One fixed scale across every Game
 * System, in explicit sort order. Not store-configurable; adding a grade is a
 * release with a migration (spec §3, #7).
 */
import { isOneOf } from './one-of';

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;

export type Condition = (typeof CONDITIONS)[number];

export function isCondition(value: unknown): value is Condition {
	return isOneOf(CONDITIONS, value);
}

/** Orders better grades first: NM, LP, MP, HP, DMG. */
export function compareCondition(a: Condition, b: Condition): number {
	return CONDITIONS.indexOf(a) - CONDITIONS.indexOf(b);
}
