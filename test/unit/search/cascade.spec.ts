import { describe, expect, it } from 'vitest';
import { cascadeStatements, firstNonEmptyTier } from '../../../server/search/cascade';
import { gameSystem } from '../../../server/search/games';
import { SEARCH_TIERS } from '../../../shared/contracts/staff/search';

const magic = gameSystem('magic')!;

describe('the five-tier cascade as statements (spec §4.3; ADR 0012)', () => {
	it('issues the tiers in order, cheapest first, for one query', () => {
		const statements = cascadeStatements(magic, { q: 'Lightning Bolt', inStock: false, facets: {}, limit: 20, offset: 0 });
		expect(statements.map(s => s.tier)).toEqual(SEARCH_TIERS);
		expect(SEARCH_TIERS).toEqual(['exact', 'nospace', 'tokens', 'phonetic', 'fuzzy']);
		expect(statements[0]!.sql).toContain(`name_folded = 'lightning bolt'`);
		expect(statements[1]!.sql).toContain(`name_folded_nospace = 'lightningbolt'`);
		expect(statements[2]!.sql).toContain(`name_folded : ("lightning" AND "bolt"*)`);
		expect(statements[3]!.sql).toContain(`name_metaphone : ("LTNNK" AND "PLT")`);
		expect(statements[4]!.sql).toContain('token_trigram');
	});

	it('folds the query the way the columns were folded', () => {
		const [exact] = cascadeStatements(magic, { q: `  Jace, the Mind-Sculptor’s `, inStock: false, facets: {}, limit: 20, offset: 0 });
		expect(exact!.sql).toContain(`name_folded = 'jace the mind sculptors'`);
	});

	it('fuzzes only tokens long enough to carry a slip, resolved against the vocabulary, and quotes them', () => {
		const [, , , , fuzzy] = cascadeStatements(magic, { q: 'mind sculper of', inStock: false, facets: {}, limit: 20, offset: 0 });
		expect(fuzzy!.sql).toContain(`' sc'`);
		expect(fuzzy!.sql).toContain(`'er '`);
		expect(fuzzy!.sql).toContain(`HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC LIMIT 10`);
		expect(fuzzy!.sql).toContain(`'"of"'`);
		expect(fuzzy!.sql).not.toContain(`' of'`);
	});

	it('applies the in-stock filter and Facet predicates to every tier, one flag column per value', () => {
		const statements = cascadeStatements(magic, {
			q: 'bolt',
			inStock: true,
			facets: { set: ['m10', 'sta'], rarity: ['common'], colour_identity: ['R', 'G'], finish: ['foil'] },
			limit: 20,
			offset: 0,
		});
		for (const { sql } of statements) {
			expect(sql).toContain(`s.on_hand > 0`);
			expect(sql).toContain(`p.set_code IN ('m10','sta')`);
			expect(sql).toContain(`p.rarity IN ('common')`);
			expect(sql).toContain(`(p.colour_r = 1 OR p.colour_g = 1)`);
			expect(sql).toContain(`p.finish IN ('foil')`);
		}
	});

	it('refuses a Facet the game does not have and a flag value with no column', () => {
		expect(() => cascadeStatements(magic, { q: 'x', inStock: false, facets: { energy_type: ['fire'] }, limit: 20, offset: 0 })).toThrow(/energy_type/);
		expect(() => cascadeStatements(magic, { q: 'x', inStock: false, facets: { colour_identity: ['P'] }, limit: 20, offset: 0 })).toThrow(/colour_identity.*P/);
	});

	it('browses with no name at all: one statement, the filters and the sort', () => {
		const statements = cascadeStatements(magic, { q: '', inStock: false, facets: { rarity: ['mythic'] }, limit: 20, offset: 40 });
		expect(statements.map(s => s.tier)).toEqual(['browse']);
		expect(statements[0]!.sql).toContain('LIMIT 20 OFFSET 40');
		expect(statements[0]!.sql).not.toContain('MATCH');
	});

	it('browses the whole game, paged, with neither a name nor a filter', () => {
		const [browse] = cascadeStatements(magic, { q: '   ', inStock: false, facets: {}, limit: 50, offset: 0 });
		expect(browse!.sql).not.toContain('pr.id = p.id WHERE');
		expect(browse!.sql).toMatch(/JOIN printing pr ON pr\.id = p\.id ORDER BY p\.name, p\.set_code, p\.collector_number LIMIT 50 OFFSET 0$/);
	});
});

describe('stop at the first non-empty tier', () => {
	const statements = cascadeStatements(magic, { q: 'bolt', inStock: false, facets: {}, limit: 20, offset: 0 });
	const empty = { results: [] };

	it('takes the first tier with rows and names it', () => {
		expect(firstNonEmptyTier(statements, [empty, empty, { results: [{ id: 'a' }] }, { results: [{ id: 'b' }] }, empty]))
			.toEqual({ tier: 'tokens', rows: [{ id: 'a' }] });
	});

	it('is a miss with no tier when every tier is empty', () => {
		expect(firstNonEmptyTier(statements, [empty, empty, empty, empty, empty])).toEqual({ tier: null, rows: [] });
	});
});
