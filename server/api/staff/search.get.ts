import type { SearchPage } from '../../../shared/contracts/staff/search';
import { getQuery } from 'h3';
import { searchPrintings, UnknownFacet } from '../../search/cascade';
import { gameSystem } from '../../search/games';
import { parseSearchQuery } from '../../search/request';

/**
 * Staff search (spec §4.3, §8.2): the five-tier cascade, game-scoped,
 * with the in-stock filter and Facet predicates, as one `batch()`.
 * `GET /api/staff/search?game=magic&q=bolt&inStock=false&facet.rarity=common`.
 */
export default defineEventHandler(async (event): Promise<SearchPage> => {
	const parsed = parseSearchQuery(getQuery(event));
	if (!parsed.ok) {
		throw apiError('VALIDATION_FAILED', { details: { issues: parsed.issues } });
	}
	const { game, ...input } = parsed.query;
	const module = gameSystem(game);
	if (!module) {
		throw apiError('NOT_FOUND', { message: `No Game System ${game}` });
	}
	try {
		return await searchPrintings(useD1(event), module, input);
	}
	catch (error) {
		if (error instanceof UnknownFacet) {
			throw apiError('VALIDATION_FAILED', { message: error.message, details: { issues: [] } });
		}
		throw error;
	}
});
