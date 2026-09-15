import type { GameSystemModule } from './module';
import { flagFacet, textFacet } from './module';

/**
 * Riftbound. Not yet in the Catalogue either; the domain codes are the
 * game's six domains as lowercase words on the same footing as One
 * Piece's colours.
 */
export const riftbound: GameSystemModule = {
	game: 'riftbound',
	table: 'riftbound_printing',
	facets: [
		flagFacet('domain', ['fury', 'calm', 'mind', 'body', 'chaos', 'order'], code => `domain_${code}`),
		textFacet('card_type'),
	],
	pricingAttributes: { rarity: 'rarity', finish: 'finish' },
};
