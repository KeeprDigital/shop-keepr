import { describe, expect, it } from 'vitest';
import { GAME_SYSTEMS, gameSystem, searchColumns, searchRow } from '../../../server/search/games';
import { fixturePrintings } from '../../support/catalogue-fixture';

const bolt = fixturePrintings().find(p => p.id === 'prt-magic-m10-146')!;
const pikachu = fixturePrintings().find(p => p.id === 'prt-pokemon-base1-58')!;
const oak = fixturePrintings().find(p => p.id === 'prt-pokemon-base1-88')!;

describe('the Game System modules (spec §4.2, ADR 0008: one module per game owns its search table)', () => {
	it('exist for the four games the store trades', () => {
		expect(GAME_SYSTEMS.map(m => [m.game, m.table])).toEqual([
			['magic', 'mtg_printing'],
			['pokemon', 'pokemon_printing'],
			['onepiece', 'onepiece_printing'],
			['riftbound', 'riftbound_printing'],
		]);
		expect(gameSystem('magic')?.table).toBe('mtg_printing');
		expect(gameSystem('lorcana')).toBeUndefined();
	});

	it('declare the §4.2 Facets per game, beyond set and rarity', () => {
		const facets = Object.fromEntries(GAME_SYSTEMS.map(m => [m.game, m.facets.map(f => f.facet)]));
		expect(facets).toEqual({
			magic: ['colour_identity', 'card_type', 'finish'],
			pokemon: ['card_kind', 'energy_type', 'stage', 'variant'],
			onepiece: ['colour', 'card_type'],
			riftbound: ['domain', 'card_type'],
		});
	});

	it('give a multi-valued Facet one boolean column per value', () => {
		const colour = gameSystem('magic')!.facets.find(f => f.facet === 'colour_identity')!;
		expect(colour).toEqual({ kind: 'flags', facet: 'colour_identity', attribute: 'colour_identity', columns: { W: 'colour_w', U: 'colour_u', B: 'colour_b', R: 'colour_r', G: 'colour_g' } });
		expect(gameSystem('onepiece')!.facets[0]).toMatchObject({ kind: 'flags', facet: 'colour' });
		expect(gameSystem('riftbound')!.facets[0]).toMatchObject({ kind: 'flags', facet: 'domain' });
	});

	it('register rarity and the finish or variant as Pricing Attributes for every game', () => {
		expect(gameSystem('magic')!.pricingAttributes).toEqual({ rarity: 'rarity', finish: 'finish' });
		expect(gameSystem('pokemon')!.pricingAttributes).toEqual({ rarity: 'rarity', variant: 'variant' });
		expect(gameSystem('onepiece')!.pricingAttributes).toEqual({ rarity: 'rarity', finish: 'finish' });
		expect(gameSystem('riftbound')!.pricingAttributes).toEqual({ rarity: 'rarity', finish: 'finish' });
	});

	it('lists every column the table needs: the shared keys, then the Facet and Pricing Attribute columns', () => {
		expect(searchColumns(gameSystem('magic')!).join(' ')).toBe(
			'id card_id name name_folded name_folded_nospace name_metaphone set_code collector_number rarity market_price withdrawn keys_version cursor synced_at'
			+ ' colour_w colour_u colour_b colour_r colour_g card_type finish',
		);
		expect(searchColumns(gameSystem('onepiece')!).slice(14)).toEqual(['colour_red', 'colour_green', 'colour_blue', 'colour_purple', 'colour_black', 'colour_yellow', 'card_type', 'finish']);
	});
});

describe('a search row from a Catalogue record', () => {
	it('carries the name keys, the sort keys and every Facet column, flags as booleans', () => {
		expect(searchRow(gameSystem('magic')!, bolt, { now: 1_800_000_000_000 })).toEqual({
			id: 'prt-magic-m10-146',
			card_id: 'card-magic-lightning-bolt',
			name: 'Lightning Bolt',
			name_folded: 'lightning bolt',
			name_folded_nospace: 'lightningbolt',
			name_metaphone: 'LTNNK PLT',
			set_code: 'm10',
			collector_number: '146',
			rarity: 'common',
			market_price: 240,
			withdrawn: false,
			keys_version: 1,
			cursor: 'magic-0029',
			synced_at: 1_800_000_000_000,
			colour_w: false,
			colour_u: false,
			colour_b: false,
			colour_r: true,
			colour_g: false,
			card_type: 'instant',
			finish: 'nonfoil',
		});
	});

	it('writes null for a text Facet the record lacks and false for every flag when the list is absent', () => {
		expect(searchRow(gameSystem('pokemon')!, oak, { now: 1 })).toMatchObject({ card_kind: 'trainer', energy_type: null, stage: null, variant: 'normal', market_price: 180 });
		const { colour_identity: _dropped, ...rest } = bolt.attributes;
		expect(searchRow(gameSystem('magic')!, { ...bolt, attributes: rest }, { now: 1 })).toMatchObject({ colour_w: false, colour_r: false });
		expect(searchRow(gameSystem('pokemon')!, pikachu, { now: 1 })).toMatchObject({ name_folded: 'pikachu', energy_type: 'lightning' });
	});

	it('refuses a flag value with no column, so the sync can quarantine the record', () => {
		expect(() => searchRow(gameSystem('magic')!, { ...bolt, attributes: { ...bolt.attributes, colour_identity: ['R', 'P'] } }, { now: 1 })).toThrow(/colour_identity.*P/);
	});
});
