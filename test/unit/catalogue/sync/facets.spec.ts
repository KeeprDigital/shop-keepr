import type { PrintingRecord } from '../../../../server/catalogue/generated/types.gen';
import { describe, expect, it } from 'vitest';
import { displayFinish } from '../../../../server/catalogue/sync/facets';
import { judgeFacets } from '../../../../server/search/mirror';
import { fixturePrintings } from '../../../support/catalogue-fixture';

const bolt = fixturePrintings().find(p => p.id === 'prt-magic-m10-146')!;
const pikachu = fixturePrintings().find(p => p.id === 'prt-pokemon-base1-58')!;

function withAttributes(record: PrintingRecord, attributes: PrintingRecord['attributes']): PrintingRecord {
	return { ...record, attributes: { ...record.attributes, ...attributes } };
}

describe('facet judgement (spec §4.2: a value that needs a column of its own is quarantined; judged by the Game System module)', () => {
	it('accepts every fixture Printing', () => {
		for (const printing of fixturePrintings()) {
			expect(judgeFacets(printing), printing.id).toEqual({ ok: true });
		}
	});

	it('refuses a Magic colour identity that has no column', () => {
		expect(judgeFacets(withAttributes(bolt, { colour_identity: ['R', 'P'] })))
			.toEqual({ ok: false, facet: 'colour_identity', value: 'P' });
	});

	it('refuses a colour identity that is not a list of codes', () => {
		expect(judgeFacets(withAttributes(bolt, { colour_identity: 'R' }))).toMatchObject({ ok: false, facet: 'colour_identity' });
	});

	it('passes a value it does not judge straight through', () => {
		expect(judgeFacets({ ...bolt, rarity: 'special' })).toEqual({ ok: true });
		expect(judgeFacets(withAttributes(bolt, { card_type: 'kindred' }))).toEqual({ ok: true });
		expect(judgeFacets(withAttributes(pikachu, { energy_type: 'dragon' }))).toEqual({ ok: true });
	});

	it('has nothing to judge for a game with no module', () => {
		expect(judgeFacets({ ...bolt, game: 'lorcana', attributes: { colour_identity: 'not even a list' } })).toEqual({ ok: true });
	});

	it('treats an absent multi-valued Facet as normal', () => {
		const { colour_identity: _dropped, ...rest } = bolt.attributes;
		expect(judgeFacets({ ...bolt, attributes: rest })).toEqual({ ok: true });
		expect(judgeFacets(withAttributes(bolt, { colour_identity: null }))).toEqual({ ok: true });
	});
});

describe('display finish', () => {
	it('is the finish for Magic and the variant for Pokémon', () => {
		expect(displayFinish(bolt)).toBe('nonfoil');
		expect(displayFinish(pikachu)).toBe('normal');
	});

	it('is null when the game states none', () => {
		expect(displayFinish(withAttributes(bolt, { finish: null }))).toBeNull();
		expect(displayFinish({ ...bolt, game: 'somegame', attributes: {} })).toBeNull();
	});
});
