/**
 * The Inventory read model (spec §8.2, `/inventory`): what the staff
 * page's table is, as the route returns it. Prices, held (active Holds) and
 * pin markers join the row with their tickets.
 */
import type { Condition } from '../../domain/condition';
import type { Language } from '../../domain/language';

export const INVENTORY_SORTS = ['name', 'setCode', 'collectorNumber', 'condition', 'language', 'onHand', 'gameSystem'] as const;

export type InventorySort = (typeof INVENTORY_SORTS)[number];

export interface InventoryQuery {
	/** Game System code; every game when absent. */
	game?: string;
	/** Name search; a plain substring match until the search cascade lands. */
	q?: string;
	sort?: InventorySort;
	direction?: 'asc' | 'desc';
}

export interface InventoryRow {
	skuId: string;
	printingId: string;
	gameSystem: string;
	name: string;
	setCode: string;
	collectorNumber: string | null;
	finish: string | null;
	rarity: string | null;
	condition: Condition;
	language: Language;
	onHand: number;
	/** The Catalogue has withdrawn the Printing; still sellable, badged. */
	withdrawn: boolean;
}

export interface InventoryPage {
	rows: InventoryRow[];
	/** The Game Systems with stock on hand, for the filter. */
	games: string[];
}
