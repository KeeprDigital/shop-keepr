/**
 * The Inventory read model (spec §8.2, `/inventory`): what the staff
 * page's table is, as the route returns it. Held (active Holds) joins the
 * row with the Basket ticket; the pin actions with the Pinned Price one.
 */
import type { Condition } from '../../domain/condition';
import type { Language } from '../../domain/language';
import type { Money } from '../../domain/money';
import type { PriceSource } from '../../domain/reprice';

export const INVENTORY_SORTS = ['name', 'setCode', 'collectorNumber', 'condition', 'language', 'onHand', 'gameSystem', 'sellPrice', 'buyPrice', 'marketPrice'] as const;

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
	/** Stored columns (spec §6): null until priced, or while nothing converts. */
	sellPrice: Money | null;
	sellPriceSource: PriceSource;
	buyPrice: Money | null;
	buyPriceSource: PriceSource;
	/** The Catalogue's rate, in its currency; staff-visible, never a customer's. */
	marketPrice: number | null;
	marketPriceCurrency: string | null;
	pricedAt: number | null;
	/** The Catalogue has withdrawn the Printing; still sellable, badged. */
	withdrawn: boolean;
}

export interface InventoryPage {
	rows: InventoryRow[];
	/** The Game Systems with stock on hand or a pin, for the filter. */
	games: string[];
	/** The Store's trading currency, ISO 4217, for formatting the prices. */
	currency: string;
}
