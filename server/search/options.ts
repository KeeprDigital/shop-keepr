/**
 * What the filter controls are built from (spec §4.2, _Reference and
 * settings tables_): the registered Game Systems, the game's sets and
 * each Facet's values as `catalogue_vocabulary` lists them. Nothing here
 * hardcodes a rarity name or `DISTINCT`-scans Printings; a Facet the
 * vocabulary has no values for yet is an empty control.
 */
import type { FacetOption, FacetValue, SearchOptions } from '../../shared/contracts/staff/search';
import type { D1Client } from './cascade';
import { GAME_SYSTEMS, gameSystem } from './games';

/** The options for one Game System; undefined for a game with no module. */
export async function readSearchOptions(db: D1Client, game: string): Promise<SearchOptions | undefined> {
	const module = gameSystem(game);
	if (!module) {
		return undefined;
	}
	const [sets, vocabulary] = await db.batch<{ code: string; name: string; facet: string }>([
		db.prepare(`SELECT code, name FROM catalogue_set WHERE game_system = ?1 ORDER BY released_on DESC, code`).bind(game),
		db.prepare(`SELECT facet, code, name FROM catalogue_vocabulary WHERE game_system = ?1 ORDER BY facet, sort_order, code`).bind(game),
	]);
	const valuesOf = (facet: string): FacetValue[] => vocabulary!.results.filter(row => row.facet === facet).map(({ code, name }) => ({ code, name }));
	const facets: FacetOption[] = [
		{ facet: 'rarity', multiValued: false, values: valuesOf('rarity') },
		...module.facets.map(facet => ({ facet: facet.facet, multiValued: facet.kind === 'flags', values: valuesOf(facet.facet) })),
	];
	return {
		games: GAME_SYSTEMS.map(m => m.game),
		sets: sets!.results.map(({ code, name }) => ({ code, name })),
		facets,
	};
}
