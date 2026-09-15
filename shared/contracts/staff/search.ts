/**
 * The search read model (spec §4.3, §8.2 _Lookup_): what the staff search
 * route takes and returns. One search serves Lookup, Large Buy, Ingest
 * and Customer List resolution; the kiosk's route shapes the same rows
 * for a customer. Sell and Buy Prices and the pin marker join the row
 * with the pricing ticket.
 */

/** The cascade's tiers, cheapest first; a search stops at the first with rows (ADR 0012). */
export const SEARCH_TIERS = ['exact', 'nospace', 'tokens', 'phonetic', 'fuzzy'] as const;

export type SearchTier = (typeof SEARCH_TIERS)[number];

/** Which tier answered: a cascade tier, `browse` for a search with no name (filters only), or null for a miss. */
export type AnsweredBy = SearchTier | 'browse' | null;

export interface SearchQuery {
	/** Game System code; search is game-scoped, always. */
	game: string;
	/** The name as typed; folded server-side. Empty browses by the filters alone. */
	q?: string;
	/** Only Printings with a SKU on hand; off on Lookup so found-but-unstocked reads as found. */
	inStock?: boolean;
	limit?: number;
	offset?: number;
	/**
	 * Facet code → the values to match, any of. `set` and `rarity` on every
	 * game; the rest per the game's module. Values are matched by string
	 * compare against the codes `catalogue_vocabulary` lists.
	 */
	facets?: Record<string, string[]>;
}

export interface SearchRow {
	printingId: string;
	cardId: string;
	name: string;
	setCode: string;
	collectorNumber: string | null;
	finish: string | null;
	rarity: string | null;
	/** Integer minor units of `marketPriceCurrency`; the Catalogue's currency, not the Store's. */
	marketPrice: number | null;
	marketPriceCurrency: string | null;
	withdrawn: boolean;
	/** Copies on hand across every Condition and Language; 0 reads as _none held_. */
	held: number;
	/** The first face's thumbnail from the Catalogue's CDN, or null. */
	thumbnail: string | null;
}

export interface SearchPage {
	answeredBy: AnsweredBy;
	rows: SearchRow[];
}

export interface FacetValue {
	code: string;
	name: string;
}

/** One filter control: a Facet and the values `catalogue_vocabulary` lists for it. */
export interface FacetOption {
	facet: string;
	/** Whether a Printing carries several values (colour identity) or one. */
	multiValued: boolean;
	values: FacetValue[];
}

/** What the filter controls for one Game System are built from; nothing here is hardcoded. */
export interface SearchOptions {
	/** Every Game System with a module, whether or not the Mirror holds it yet. */
	games: string[];
	sets: FacetValue[];
	facets: FacetOption[];
}
