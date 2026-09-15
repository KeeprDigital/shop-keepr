import type { CatalogueRecord, PrintingRecord } from '../../../server/catalogue/generated/types.gen';
import { describe, expect, it } from 'vitest';
import { zCataloguePage, zMarketPricePage, zPrintingRecord } from '../../../server/catalogue/generated/zod.gen';
import { readFixturePages } from '../../support/catalogue-fixture';

const pages = readFixturePages();

describe('generated schemas against the fixture', () => {
	it('has a fixture to validate', () => {
		expect(pages.length).toBeGreaterThan(0);
	});

	it.each(pages)('validates every record of $path', ({ path, body }) => {
		const schema = path.includes('/market-prices/') ? zMarketPricePage : zCataloguePage;
		const result = schema.safeParse(body);
		expect(result.error?.issues ?? []).toEqual([]);
	});

	it('rejects a deliberately broken record', () => {
		const valid = printings().find(p => p.id === 'prt-magic-m10-146')!;
		expect(zPrintingRecord.safeParse(valid).success).toBe(true);

		const { card_id: _dropped, ...withoutCard } = valid;
		expect(zPrintingRecord.safeParse(withoutCard).success).toBe(false);

		const fractionalPrice = { ...valid, market_price: { amount: 2.4, currency: 'USD' } };
		expect(zPrintingRecord.safeParse(fractionalPrice).success).toBe(false);

		const joinedColours = { ...valid, attributes: { ...valid.attributes, colour_identity: [['R']] } };
		expect(zPrintingRecord.safeParse(joinedColours).success).toBe(false);
	});
});

describe('what the fixture holds (spec §5, _Environments and test tiers_)', () => {
	const all = printings();

	it('covers more than one Game System', () => {
		expect(new Set(all.map(p => p.game)).size).toBeGreaterThan(1);
	});

	it('holds several Printings of one Card', () => {
		const bolts = all.filter(p => p.card_id === 'card-magic-lightning-bolt');
		expect(bolts.length).toBeGreaterThanOrEqual(3);
		expect(new Set(bolts.map(p => p.id)).size).toBe(bolts.length);
	});

	it('holds a withdrawn Printing as a full record', () => {
		const withdrawn = all.filter(p => p.withdrawn);
		expect(withdrawn.length).toBeGreaterThanOrEqual(1);
		expect(withdrawn[0]!.name).toBe('Lightning Bolt');
	});

	it('holds two Cards sharing a name', () => {
		const pikachus = new Set(all.filter(p => p.name === 'Pikachu').map(p => p.card_id));
		expect(pikachus.size).toBeGreaterThanOrEqual(2);
	});

	it('holds non-Latin and awkwardly long names', () => {
		expect(all.some(p => /\p{Script=Katakana}/u.test(p.name))).toBe(true);
		expect(Math.max(...all.map(p => p.name.length))).toBeGreaterThan(100);
	});

	it('exercises the full Magic Facet range', () => {
		const magic = all.filter(p => p.game === 'magic');
		const vocabulary = records().filter(r => r.kind === 'vocabulary' && r.game === 'magic');
		const codesFor = (facet: string) => new Set(vocabulary.filter(v => v.facet === facet).map(v => v.code));
		const seen = (pick: (p: PrintingRecord) => unknown) => new Set(magic.flatMap(p => [pick(p)].flat()));

		expect(seen(p => p.rarity)).toEqual(codesFor('rarity'));
		expect(seen(p => p.attributes.colour_identity)).toEqual(codesFor('colour_identity'));
		expect(seen(p => p.attributes.card_type)).toEqual(codesFor('card_type'));
		expect(seen(p => p.attributes.finish)).toEqual(codesFor('finish'));
		expect(magic.some(p => Array.isArray(p.attributes.colour_identity) && p.attributes.colour_identity.length > 1)).toBe(true);
	});

	it('holds a Printing with and without a Market Price', () => {
		expect(all.some(p => p.market_price !== null && p.market_price_cursor !== null)).toBe(true);
		expect(all.some(p => p.market_price === null && p.market_price_cursor === null)).toBe(true);
	});

	it('walks every price movement the Printings cite, exhaustively from cursor zero', () => {
		const movements = pages
			.filter(page => /market-prices\/0\.json$/.test(page.path))
			.flatMap(page => zMarketPricePage.parse(page.body).records);
		for (const p of all.filter(p => p.market_price_cursor !== null)) {
			const latest = movements.filter(m => m.printing_id === p.id).at(-1);
			expect(latest, p.id).toMatchObject({ cursor: p.market_price_cursor, market_price: p.market_price });
		}
		expect(movements.some(m => m.market_price === null)).toBe(true);
	});
});

function records(): CatalogueRecord[] {
	return pages
		.filter(page => page.path.includes('/catalogue/'))
		.flatMap(page => zCataloguePage.parse(page.body).records);
}

function printings(): PrintingRecord[] {
	return records().filter(r => r.kind === 'printing');
}
