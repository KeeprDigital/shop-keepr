import type { GameSystemModule } from './module';
import { textFacet } from './module';

/** Pokémon. Every Facet is single-valued; the variant is what pricing keys on beside rarity. */
export const pokemon: GameSystemModule = {
	game: 'pokemon',
	table: 'pokemon_printing',
	facets: [
		textFacet('card_kind'),
		textFacet('energy_type'),
		textFacet('stage'),
		textFacet('variant'),
	],
	pricingAttributes: { rarity: 'rarity', variant: 'variant' },
};
