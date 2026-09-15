import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readSearchOptions } from '../../server/search/options';
import { syncFixture } from '../support/fixture-mirror';

describe('the filter controls (spec §4.2: they read `catalogue_vocabulary`; nothing hardcodes a rarity name)', () => {
	it('lists every registered game, the game\'s sets newest first, and each Facet\'s values in vocabulary order', async () => {
		await syncFixture('magic');
		await syncFixture('pokemon');

		const options = await readSearchOptions(env.DB, 'magic');
		expect(options.games).toEqual(['magic', 'pokemon', 'onepiece', 'riftbound']);
		expect(options.sets.map(s => s.code)).toEqual(['mom', 'neo', 'sta', 'm10', 'unh', 'lea', 'ptc']);
		expect(options.sets[0]).toEqual({ code: 'mom', name: 'March of the Machine' });
		expect(options.facets.map(f => [f.facet, f.multiValued, f.values.map(v => v.code)])).toEqual([
			['rarity', false, ['common', 'uncommon', 'rare', 'mythic']],
			['colour_identity', true, ['W', 'U', 'B', 'R', 'G']],
			['card_type', false, ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'planeswalker', 'land', 'battle']],
			['finish', false, ['nonfoil', 'foil', 'etched']],
		]);
		expect(options.facets[0]!.values[0]).toEqual({ code: 'common', name: 'Common' });
	});

	it('offers a Facet with no vocabulary yet as an empty control, and a game the Mirror lacks with nothing to pick', async () => {
		await syncFixture('magic');
		expect(await readSearchOptions(env.DB, 'onepiece')).toEqual({
			games: ['magic', 'pokemon', 'onepiece', 'riftbound'],
			sets: [],
			facets: [
				{ facet: 'rarity', multiValued: false, values: [] },
				{ facet: 'colour', multiValued: true, values: [] },
				{ facet: 'card_type', multiValued: false, values: [] },
			],
		});
		expect(await readSearchOptions(env.DB, 'lorcana')).toBeUndefined();
	});
});
