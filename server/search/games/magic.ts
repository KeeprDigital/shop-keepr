import type { GameSystemModule } from './module';
import { flagFacet, textFacet } from './module';

/** Magic: The Gathering. Colour identity is WUBRG, one flag each. */
export const magic: GameSystemModule = {
	game: 'magic',
	table: 'mtg_printing',
	facets: [
		flagFacet('colour_identity', ['W', 'U', 'B', 'R', 'G'], code => `colour_${code.toLowerCase()}`),
		textFacet('card_type'),
		textFacet('finish'),
	],
	pricingAttributes: { rarity: 'rarity', finish: 'finish' },
};
