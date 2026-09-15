import type { PrintingRecord } from '../../../../server/catalogue/generated/types.gen';
import { describe, expect, it } from 'vitest';
import { displayFinish } from '../../../../server/catalogue/sync/facets';
import { fixturePrintings } from '../../../support/catalogue-fixture';

const bolt = fixturePrintings().find(p => p.id === 'prt-magic-m10-146')!;
const pikachu = fixturePrintings().find(p => p.id === 'prt-pokemon-base1-58')!;

function withAttributes(record: PrintingRecord, attributes: PrintingRecord['attributes']): PrintingRecord {
	return { ...record, attributes: { ...record.attributes, ...attributes } };
}

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
