import type { PricingSettings } from '../../../shared/pricing/settings';
import { describe, expect, it } from 'vitest';
import { affectedGames, resolvedSide, resolveSetting, SEEDED_STORE_SETTINGS } from '../../../shared/pricing/settings';

const GAMES = ['magic', 'pokemon', 'onepiece', 'riftbound'];

const settings: PricingSettings = {
	store: SEEDED_STORE_SETTINGS,
	games: {
		magic: { sell: {}, buy: { floor: 10 }, rows: [{ attr: 'rarity', value: 'mythic', sell: { k: 1, f: 0, floor: 100 }, buy: { k: 1, f: 0, floor: 50 } }] },
		pokemon: { sell: { floor: 50 }, buy: {}, rows: [] },
	},
};

describe('resolution (spec §6: per setting, attribute row → Game System → Store default, never per group)', () => {
	it('takes the Game System\'s own value where it sets one and the Store default where it does not', () => {
		expect(resolveSetting(settings, 'magic', 'buy', 'floor')).toEqual({ value: 10, from: 'magic' });
		expect(resolveSetting(settings, 'magic', 'sell', 'floor')).toEqual({ value: 25, from: 'store' });
		expect(resolveSetting(settings, 'magic', 'buy', 'rounding')).toEqual({ value: { inc: 5, dir: 'down' }, from: 'store' });
		expect(resolveSetting(settings, 'riftbound', 'buy', 'floor')).toEqual({ value: 5, from: 'store' });
	});

	it('resolves a whole side one setting at a time: a game setting its Floor does not restate its Condition multipliers', () => {
		const magic = resolvedSide(settings, 'magic', 'buy');
		expect(magic.floor).toBe(10);
		expect(magic.condition).toEqual(SEEDED_STORE_SETTINGS.buy.condition);
		expect(magic.tender).toEqual({ def: 'cash', mod: 0 });
	});
});

describe('the sweep estimate (spec §6, _Sweep estimate on Save_)', () => {
	it('reaches one game for a game-scope change', () => {
		expect(affectedGames(settings, { scope: 'magic', side: 'buy', key: 'floor' }, GAMES)).toEqual(['magic']);
		expect(affectedGames(settings, { scope: 'magic', side: 'sell', key: 'rows' }, GAMES)).toEqual(['magic']);
	});

	it('reaches every game that inherits a Store default, and none that overrides it', () => {
		expect(affectedGames(settings, { scope: 'store', side: 'buy', key: 'floor' }, GAMES)).toEqual(['pokemon', 'onepiece', 'riftbound']);
		expect(affectedGames(settings, { scope: 'store', side: 'sell', key: 'floor' }, GAMES)).toEqual(['magic', 'onepiece', 'riftbound']);
		expect(affectedGames(settings, { scope: 'store', side: 'sell', key: 'condition' }, GAMES)).toEqual(GAMES);
	});

	it('reaches nothing for Tender, which acts on a total and never on a price', () => {
		expect(affectedGames(settings, { scope: 'store', side: 'buy', key: 'tender' }, GAMES)).toEqual([]);
	});
});
