import type { GameSystemModule } from './module';
import { flagFacet, textFacet } from './module';

/**
 * One Piece. The Catalogue does not cover it yet (spec §5, _Game System
 * coverage stance_), so the colour codes are the game's six colours as
 * lowercase words until a record says otherwise; a code outside the list
 * quarantines, never fails, the sync. Finish is a Pricing Attribute here
 * without being a Facet.
 */
export const onepiece: GameSystemModule = {
	game: 'onepiece',
	table: 'onepiece_printing',
	facets: [
		flagFacet('colour', ['red', 'green', 'blue', 'purple', 'black', 'yellow'], code => `colour_${code}`),
		textFacet('card_type'),
	],
	pricingAttributes: { rarity: 'rarity', finish: 'finish' },
};
