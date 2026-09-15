import type { PriceQuery } from '../../../shared/pricing/evaluate';
import type { PricingSettings } from '../../../shared/pricing/settings';
import { describe, expect, it } from 'vitest';
import { evaluatePrice } from '../../../shared/pricing/evaluate';
import { SEEDED_STORE_SETTINGS } from '../../../shared/pricing/settings';

/** The prototype's demo settings, verbatim: the Store seed plus its Game System overrides. */
const settings: PricingSettings = {
	store: SEEDED_STORE_SETTINGS,
	games: {
		magic: {
			sell: {},
			buy: { valueBands: [{ from: 0, pct: 55, f: 0 }, { from: 500, pct: 62, f: 0 }, { from: 2000, pct: 70, f: 0 }] },
			rows: [
				{ attr: 'rarity', value: 'mythic', sell: { k: 1, f: 100, floor: 100 }, buy: { k: 1, f: 0, floor: 50 } },
				{ attr: 'finish', value: 'foil', sell: { k: 1.1, f: 0, floor: null }, buy: { k: 1, f: 0, floor: null } },
			],
		},
		pokemon: {
			sell: { condition: { NM: { k: 1, f: 0 }, LP: { k: 0.9, f: 0 }, MP: { k: 0.75, f: 0 }, HP: { k: 0.55, f: 0 }, DMG: { k: 0.35, f: 0 } } },
			buy: {},
			rows: [{ attr: 'rarity', value: 'illustration rare', sell: { k: 1, f: 0, floor: 200 }, buy: { k: 1, f: 0, floor: 100 } }],
		},
		onepiece: { sell: {}, buy: { floor: 10 }, rows: [] },
	},
};

/** The prototype's Stock and Quantity Bands, which the seed leaves neutral. */
const banded: PricingSettings = {
	...settings,
	store: {
		...settings.store,
		buy: {
			...settings.store.buy,
			stockBands: [{ from: 0, k: 1, f: 0 }, { from: 4, k: 0.75, f: 0 }, { from: 8, k: 0.5, f: 0 }],
			qtyBands: [{ from: 1, k: 1, f: 0 }, { from: 4, k: 0.9, f: 0 }],
		},
	},
};

/** A Magic rare, $10 in the Catalogue's currency, converted at the prototype's 0.78. */
const rare: PriceQuery = { side: 'sell', game: 'magic', condition: 'NM', language: 'en', marketPrice: 1000, fxRate: 0.78, attributes: { rarity: 'rare', finish: 'nonfoil' }, onHand: 0, quantity: 1 };

const steps = (result: ReturnType<typeof evaluatePrice>) => result.trace.map(t => [t.step, t.after]);

describe('the evaluator (ADR 0004: one fold over an ordered step list; the prototype is the reference)', () => {
	it('reproduces the prototype: a Magic rare at $10 sells at £7.80 and buys at £4.80', () => {
		expect(evaluatePrice(banded, rare).price).toBe(780);
		expect(steps(evaluatePrice(banded, rare))).toEqual([['fx', 780], ['condition', 780], ['language', 780], ['percentage', 780], ['attributes', 780], ['round', 780], ['floor', 780]]);
		const buy = evaluatePrice(banded, { ...rare, side: 'buy' });
		expect(buy.price).toBe(480);
		expect(steps(buy)).toEqual([['fx', 780], ['condition', 780], ['language', 780], ['percentage', 484], ['stock', 484], ['quantity', 484], ['attributes', 484], ['round', 480], ['floor', 480]]);
	});

	it('reproduces the prototype: a Lightly Played Japanese foil mythic, every step in turn', () => {
		const mythic: PriceQuery = { ...rare, condition: 'LP', language: 'ja', attributes: { rarity: 'mythic', finish: 'foil' } };
		expect(steps(evaluatePrice(banded, mythic))).toEqual([['fx', 780], ['condition', 663], ['language', 597], ['percentage', 597], ['attributes', 767], ['round', 770], ['floor', 770]]);
		expect(steps(evaluatePrice(banded, { ...mythic, side: 'buy', onHand: 5, quantity: 4 }))).toEqual([['fx', 780], ['condition', 624], ['language', 499], ['percentage', 309], ['stock', 232], ['quantity', 209], ['attributes', 209], ['round', 205], ['floor', 205]]);
	});

	it('reproduces the prototype: a Pokémon illustration rare under the game\'s own Condition multipliers', () => {
		const query: PriceQuery = { ...rare, game: 'pokemon', marketPrice: 10000, attributes: { rarity: 'illustration rare', variant: 'holo' } };
		expect(evaluatePrice(banded, query).price).toBe(8580);
		expect(evaluatePrice(banded, { ...query, side: 'buy', condition: 'MP', language: 'de', onHand: 4, quantity: 10 }).price).toBe(1435);
		expect(steps(evaluatePrice(banded, { ...rare, game: 'pokemon', condition: 'LP', marketPrice: 300, attributes: { rarity: 'common', variant: null } }))).toEqual([['fx', 234], ['condition', 211], ['language', 211], ['percentage', 211], ['attributes', 211], ['round', 220], ['floor', 220]]);
	});

	it('keys the Value Band on the converted Market Price, and takes the highest band at or under it', () => {
		// $64.10 converts to £50.00: the 5000+ band, 110 %.
		expect(steps(evaluatePrice(settings, { ...rare, marketPrice: 6410 }))).toEqual([['fx', 5000], ['condition', 5000], ['language', 5000], ['percentage', 5500], ['attributes', 5500], ['round', 5500], ['floor', 5500]]);
		// £49.99 stays in the 1000+ band; £9.99 in the first.
		expect(evaluatePrice(settings, { ...rare, marketPrice: 6409 }).trace[3]).toMatchObject({ step: 'percentage', after: 5249 });
		expect(evaluatePrice(settings, { ...rare, marketPrice: 1280 }).trace[3]).toMatchObject({ step: 'percentage', after: 998 });
		// Magic's own Buy bands: £5.00 is the 500+ band, 62 %.
		expect(evaluatePrice(settings, { ...rare, side: 'buy', marketPrice: 641 }).price).toBe(310);
	});

	it('takes the first band when nothing matches, so a key under every `from` still prices', () => {
		const stepped: PricingSettings = { ...settings, store: { ...settings.store, buy: { ...settings.store.buy, qtyBands: [{ from: 4, k: 0.9, f: 0 }, { from: 8, k: 0.8, f: 0 }] } } };
		expect(evaluatePrice(stepped, { ...rare, side: 'buy', quantity: 1 }).trace.find(t => t.step === 'quantity')).toMatchObject({ before: 484, after: 436 });
	});

	it('applies a Stock Band on on-hand and a Quantity Band on the line quantity, Buy side only', () => {
		const buy = { ...rare, side: 'buy' as const };
		expect(evaluatePrice(banded, { ...buy, onHand: 3 }).price).toBe(480);
		expect(evaluatePrice(banded, { ...buy, onHand: 4 }).price).toBe(360);
		expect(evaluatePrice(banded, { ...buy, onHand: 8 }).price).toBe(240);
		expect(evaluatePrice(banded, { ...buy, quantity: 4 }).price).toBe(435);
		expect(evaluatePrice(banded, { ...buy, quantity: 4, onHand: 9 }).price).toBe(215);
		// The Sell side has neither step, whatever the settings or the query say.
		expect(evaluatePrice(banded, { ...rare, onHand: 9, quantity: 4 }).price).toBe(780);
	});

	it('applies every matching attribute row in turn and ignores rows for other values', () => {
		const foilMythic = evaluatePrice(settings, { ...rare, attributes: { rarity: 'mythic', finish: 'foil' } });
		// 780 → +100 (mythic) → ×1.1 (foil) = 968 → 970.
		expect(foilMythic.trace.find(t => t.step === 'attributes')).toMatchObject({ before: 780, after: 968 });
		expect(foilMythic.price).toBe(970);
		expect(evaluatePrice(settings, { ...rare, attributes: { rarity: 'mythic', finish: null } }).price).toBe(880);
	});

	it('lets the highest Floor win among the scope Floor and every matching row, never stacking them', () => {
		// $1 mythic: 78p sells, +100 mythic flat = 178 → 180, above the mythic Floor of £1.
		expect(evaluatePrice(settings, { ...rare, marketPrice: 100, attributes: { rarity: 'mythic', finish: 'nonfoil' } }).price).toBe(180);
		// Buy: 78p × 55 % = 43 → 40, raised to the mythic Buy Floor of 50p, not the Bulk Price of 5p.
		expect(steps(evaluatePrice(settings, { ...rare, side: 'buy', marketPrice: 100, attributes: { rarity: 'mythic', finish: 'nonfoil' } }))).toEqual([['fx', 78], ['condition', 78], ['language', 78], ['percentage', 43], ['stock', 43], ['quantity', 43], ['attributes', 43], ['round', 40], ['floor', 50]]);
		// Two rows with Floors: the higher holds, once.
		const twoFloors: PricingSettings = { ...settings, games: { ...settings.games, magic: { ...settings.games.magic!, rows: [
			{ attr: 'rarity', value: 'mythic', sell: { k: 1, f: 0, floor: 100 }, buy: { k: 1, f: 0, floor: 50 } },
			{ attr: 'finish', value: 'foil', sell: { k: 1, f: 0, floor: 300 }, buy: { k: 1, f: 0, floor: 20 } },
		] } } };
		expect(evaluatePrice(twoFloors, { ...rare, marketPrice: 10, attributes: { rarity: 'mythic', finish: 'foil' } }).price).toBe(300);
		expect(evaluatePrice(twoFloors, { ...rare, side: 'buy', marketPrice: 10, attributes: { rarity: 'mythic', finish: 'foil' } }).price).toBe(50);
	});

	it('never refuses a card: a Buy that rounds to nothing answers with the Bulk Price', () => {
		// One Piece sets its Bulk Price to 10p; 8p × 50 % = 4 → rounds down to 0 → 10p.
		expect(steps(evaluatePrice(settings, { ...rare, side: 'buy', game: 'onepiece', marketPrice: 10, attributes: { rarity: 'C', finish: null } }))).toEqual([['fx', 8], ['condition', 8], ['language', 8], ['percentage', 4], ['stock', 4], ['quantity', 4], ['attributes', 4], ['round', 0], ['floor', 10]]);
		// A Damaged Magic common: 16p → 3 → 2 → 0 after rounding → the Store's Bulk Price of 5p.
		expect(evaluatePrice(banded, { ...rare, side: 'buy', condition: 'DMG', marketPrice: 20, attributes: { rarity: 'common', finish: 'nonfoil' }, onHand: 9 }).price).toBe(5);
		// A band that wants to stop buying sets k = 0.
		const stopped: PricingSettings = { ...settings, store: { ...settings.store, buy: { ...settings.store.buy, stockBands: [{ from: 0, k: 1, f: 0 }, { from: 4, k: 0, f: 0 }] } } };
		expect(evaluatePrice(stopped, { ...rare, side: 'buy', onHand: 4 }).price).toBe(5);
	});

	it('rounds before it floors by default, so a Floor holds; reversed, the Floor rounds away', () => {
		// Sell: 16p × 30 % (DMG) = 5 → up to 10p → Floor 25p.
		expect(steps(evaluatePrice(settings, { ...rare, condition: 'DMG', marketPrice: 20 }))).toEqual([['fx', 16], ['condition', 5], ['language', 5], ['percentage', 5], ['attributes', 5], ['round', 10], ['floor', 25]]);
		const floorFirst: PricingSettings = { ...settings, store: { ...settings.store, sell: { ...settings.store.sell, floor: 45, rounding: { inc: 50, dir: 'nearest' }, steps: ['fx', 'condition', 'language', 'percentage', 'attributes', 'floor', 'round'] } } };
		expect(evaluatePrice(floorFirst, { ...rare, condition: 'DMG', marketPrice: 20 }).price).toBe(50);
		expect(evaluatePrice({ ...floorFirst, store: { ...floorFirst.store, sell: { ...floorFirst.store.sell, floor: 40 } } }, { ...rare, condition: 'DMG', marketPrice: 20 }).price).toBe(50);
		expect(evaluatePrice({ ...floorFirst, store: { ...floorFirst.store, sell: { ...floorFirst.store.sell, floor: 24 } } }, { ...rare, condition: 'DMG', marketPrice: 20 }).price).toBe(0);
	});

	it('rounds to the increment in the side\'s direction', () => {
		const at = (inc: number, dir: 'up' | 'down' | 'nearest', marketPrice: number) =>
			evaluatePrice({ ...settings, store: { ...settings.store, sell: { ...settings.store.sell, rounding: { inc, dir }, floor: 0 } } }, { ...rare, marketPrice }).price;
		// $1.30 → 101p.
		expect(at(10, 'up', 130)).toBe(110);
		expect(at(10, 'down', 130)).toBe(100);
		expect(at(10, 'nearest', 130)).toBe(100);
		expect(at(25, 'nearest', 130)).toBe(100);
		expect(at(1, 'up', 130)).toBe(101);
	});

	it('applies a flat at its own step, so an early flat is scaled by later multipliers and a late one lands whole', () => {
		const flatOnCondition: PricingSettings = { ...settings, store: { ...settings.store, sell: { ...settings.store.sell, condition: { ...settings.store.sell.condition, NM: { k: 1, f: 100 } } } } };
		// 780 + 100 = 880 → 110 % (band 5000+? no: 780 is band 0) → 100 %: 880. Use a 105 % band: $12.82 → 1000 + 100 = 1100 × 1.05 = 1155 → 1160.
		expect(evaluatePrice(flatOnCondition, { ...rare, marketPrice: 1282 }).price).toBe(1160);
		const flatOnBand: PricingSettings = { ...settings, store: { ...settings.store, sell: { ...settings.store.sell, valueBands: [{ from: 0, pct: 105, f: 100 }] } } };
		expect(evaluatePrice(flatOnBand, { ...rare, marketPrice: 1282 }).price).toBe(1150);
	});

	it('treats a Language with no entry as ×1 +0', () => {
		expect(evaluatePrice(settings, { ...rare, language: 'ko' }).price).toBe(780);
		expect(evaluatePrice(settings, { ...rare, language: 'ja' }).price).toBe(710);
	});

	it('converts at the first step whatever the order says, and is unmoved by a Sell-side stock or quantity step', () => {
		const shuffled: PricingSettings = { ...settings, store: { ...settings.store, sell: { ...settings.store.sell, steps: ['condition', 'stock', 'fx', 'round', 'floor'] } } };
		const result = evaluatePrice(shuffled, { ...rare, condition: 'LP' });
		expect(result.converted).toBe(780);
		expect(steps(result)).toEqual([['fx', 780], ['condition', 663], ['round', 670], ['floor', 670]]);
	});

	it('prices a game with no rules of its own from the Store defaults alone', () => {
		expect(evaluatePrice(settings, { ...rare, game: 'riftbound', attributes: { rarity: 'epic', finish: 'foil' } }).price).toBe(780);
		expect(evaluatePrice(settings, { ...rare, side: 'buy', game: 'riftbound', attributes: { rarity: 'epic', finish: 'foil' } }).price).toBe(465);
	});
});
