import type { CascadeInput } from '../../server/search/cascade';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMirrorIndexes } from '../../server/catalogue/sync/run';
import { createDb } from '../../server/db/client';
import { recordAdjustment } from '../../server/ledger/adjustment';
import { searchPrintings } from '../../server/search/cascade';
import { gameSystem } from '../../server/search/games';
import { deltaPages, fixturePrinting, LAST_MAGIC_CURSOR, syncFixture } from '../support/fixture-mirror';
import { STAFF_ACTOR } from '../support/stock';

const magic = gameSystem('magic')!;
const pokemon = gameSystem('pokemon')!;

function search(q: string, overrides: Partial<CascadeInput> & { game?: 'magic' | 'pokemon' } = {}) {
	const { game = 'magic', ...rest } = overrides;
	return searchPrintings(env.DB, game === 'magic' ? magic : pokemon, { q, inStock: false, facets: {}, limit: 20, offset: 0, ...rest });
}

const ids = (page: { rows: { printingId: string }[] }) => page.rows.map(r => r.printingId);
const BOLTS = ['prt-magic-lea-161', 'prt-magic-m10-146', 'prt-magic-m10-146-foil', 'prt-magic-ptc-161', 'prt-magic-sta-105-etched', 'prt-magic-sta-42'];

async function count(sql: string): Promise<number> {
	return (await env.DB.prepare(sql).first<{ n: number }>())!.n;
}

describe('the search read model written by the sync (spec §4.2, §5 _Write shape_; ADR 0008)', () => {
	beforeEach(async () => {
		await syncFixture('magic');
		await syncFixture('pokemon');
	});

	it('fills the game\'s search table, its FTS5 index and the trigram vocabulary from the same records', async () => {
		expect(await count('SELECT COUNT(*) AS n FROM mtg_printing')).toBe(17);
		expect(await count('SELECT COUNT(*) AS n FROM pokemon_printing')).toBe(6);
		expect(await count('SELECT COUNT(*) AS n FROM onepiece_printing')).toBe(0);
		expect(await env.DB.prepare(`SELECT name_folded, name_folded_nospace, name_metaphone, colour_r, colour_u, card_type, finish, market_price FROM mtg_printing WHERE id = 'prt-magic-m10-146'`).first())
			.toEqual({ name_folded: 'lightning bolt', name_folded_nospace: 'lightningbolt', name_metaphone: 'LTNNK PLT', colour_r: 1, colour_u: 0, card_type: 'instant', finish: 'nonfoil', market_price: 240 });
		expect(await count(`SELECT COUNT(*) AS n FROM mtg_printing_fts WHERE mtg_printing_fts MATCH 'name_folded : "lightning"'`)).toBe(7);
		expect(await count(`SELECT COUNT(*) AS n FROM token_trigram WHERE token = 'lightning'`)).toBe(11);
		expect(await count(`SELECT COUNT(*) AS n FROM token_trigram WHERE token = 'ピカチュウ'`)).toBe(7);
		await expect(env.DB.prepare(`INSERT INTO mtg_printing_fts(mtg_printing_fts) VALUES('integrity-check')`).run()).resolves.toBeDefined();
	});

	it('builds the search indexes with the Mirror\'s, after the seed', async () => {
		await buildMirrorIndexes(env.DB);
		const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mtg_printing' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name`).all<{ name: string }>();
		expect(results.map(r => r.name)).toEqual(['mtg_printing_card', 'mtg_printing_folded', 'mtg_printing_folded_nospace', 'mtg_printing_set_number']);
	});

	it('keeps the FTS5 index and the vocabulary in step with a delta: a renamed Printing is findable under the new name only', async () => {
		const bolt = 'prt-magic-m10-146';
		await syncFixture('magic', { pages: deltaPages('magic', [{ ...fixturePrinting(bolt), name: 'Thunder Bolt', cursor: 'magic-0045' }], LAST_MAGIC_CURSOR), from: 'stored' });

		expect(await search('Thunder Bolt')).toMatchObject({ answeredBy: 'exact' });
		expect(ids(await search('Thunder Bolt'))).toEqual([bolt]);
		expect(ids(await search('lightning bolt'))).toEqual(BOLTS.filter(id => id !== bolt));
		expect(ids(await search('bolt thunder'))).toEqual([bolt]);
		expect(await search('thunfer bolt')).toMatchObject({ answeredBy: 'fuzzy', rows: [expect.objectContaining({ printingId: bolt, name: 'Thunder Bolt' })] });
		await expect(env.DB.prepare(`INSERT INTO mtg_printing_fts(mtg_printing_fts) VALUES('integrity-check')`).run()).resolves.toBeDefined();
	});

	it('fills a search table the Mirror was walked before it existed, on the next full walk', async () => {
		await env.DB.batch([
			env.DB.prepare(`DELETE FROM mtg_printing`),
			env.DB.prepare(`INSERT INTO mtg_printing_fts(mtg_printing_fts) VALUES('delete-all')`),
		]);
		expect(await search('lightning bolt')).toEqual({ answeredBy: null, rows: [] });

		const run = await syncFixture('magic');
		expect(run.counts).toEqual({ seen: 44, written: 17, quarantined: 0, drifted: 0 });
		expect(ids(await search('lightning bolt'))).toEqual(BOLTS);
		expect((await syncFixture('magic')).counts.written).toBe(0);
	});

	it('rewrites every search row of the game on the next full walk after the name-key rule changes version', async () => {
		await env.DB.prepare(`UPDATE mtg_printing SET keys_version = 0, name_folded = 'stale' WHERE id = 'prt-magic-m10-146'`).run();
		expect(ids(await search('lightning bolt'))).toEqual(BOLTS.filter(id => id !== 'prt-magic-m10-146'));

		const run = await syncFixture('magic');
		expect(run.counts).toEqual({ seen: 44, written: 1, quarantined: 0, drifted: 0 });
		expect(ids(await search('lightning bolt'))).toEqual(BOLTS);
	});

	it('copies the Market Price `printing` holds, never a null over a rate', async () => {
		const bolt = 'prt-magic-m10-146';
		await syncFixture('magic', { pages: deltaPages('magic', [{ ...fixturePrinting(bolt), market_price: null, market_price_cursor: null, cursor: 'magic-0045' }], LAST_MAGIC_CURSOR), from: 'stored' });
		expect(await env.DB.prepare(`SELECT market_price FROM mtg_printing WHERE id = ?1`).bind(bolt).first()).toEqual({ market_price: 240 });

		await syncFixture('magic', { pages: deltaPages('magic', [{ ...fixturePrinting(bolt), market_price: { amount: 260, currency: 'USD' }, market_price_cursor: 'magic-price-0099', cursor: 'magic-0046' }], 'magic-0045'), from: 'stored' });
		expect(await env.DB.prepare(`SELECT market_price FROM mtg_printing WHERE id = ?1`).bind(bolt).first()).toEqual({ market_price: 260 });
	});
});

describe('the five-tier cascade (spec §4.3; ADR 0012)', () => {
	beforeEach(async () => {
		await syncFixture('magic');
		await syncFixture('pokemon');
	});

	it('tier 1: the folded name exactly, whatever the case, accents and punctuation typed', async () => {
		const page = await search('Lightning Bolt');
		expect(page.answeredBy).toBe('exact');
		expect(ids(page)).toEqual(BOLTS);
		expect(page.rows[1]).toEqual({
			printingId: 'prt-magic-m10-146',
			cardId: 'card-magic-lightning-bolt',
			name: 'Lightning Bolt',
			setCode: 'm10',
			collectorNumber: '146',
			finish: 'nonfoil',
			rarity: 'common',
			marketPrice: 240,
			marketPriceCurrency: 'USD',
			withdrawn: false,
			held: 0,
			thumbnail: 'https://images.catalogue.test/printings/prt-magic-m10-146/0/thumbnail.jpg',
		});
		expect(page.rows.find(r => r.printingId === 'prt-magic-ptc-161')).toMatchObject({ withdrawn: true });
		expect(await search('  lightning-BOLT! ')).toMatchObject({ answeredBy: 'exact' });
		expect(await search('Invasion of Zendikar // Awakened Skyclave')).toMatchObject({ answeredBy: 'exact', rows: [expect.objectContaining({ printingId: 'prt-magic-mom-194' })] });
	});

	it('tier 2: the name with its spaces stripped', async () => {
		const page = await search('lightningbolt');
		expect(page.answeredBy).toBe('nospace');
		expect(ids(page)).toEqual(BOLTS);
	});

	it('tier 3: a subset of the tokens in any order, the last as a prefix', async () => {
		expect(await search('bolt lightning')).toMatchObject({ answeredBy: 'tokens' });
		expect(ids(await search('bolt lightning'))).toEqual(BOLTS);
		expect(ids(await search('emperor wandering'))).toEqual(['prt-magic-neo-42']);
		expect(ids(await search('bolt'))).toEqual(BOLTS);
		expect(ids(await search('lightning'))).toEqual([...BOLTS, 'prt-magic-sta-12']);
		expect(ids(await search('wander'))).toEqual(['prt-magic-neo-42']);
	});

	it('tier 4: a phonetic respelling', async () => {
		const page = await search('lightening bolt');
		expect(page.answeredBy).toBe('phonetic');
		expect(ids(page)).toEqual(BOLTS);
	});

	it('tier 5: a keyboard slip in one token, resolved against the vocabulary and AND-ed with the rest', async () => {
		const page = await search('lughtning bolt');
		expect(page.answeredBy).toBe('fuzzy');
		expect(ids(page)).toEqual(BOLTS);
		expect(await search('wanfering emperor')).toMatchObject({ answeredBy: 'fuzzy', rows: [expect.objectContaining({ printingId: 'prt-magic-neo-42' })] });
	});

	it('is a miss, and never another game, when no tier answers', async () => {
		expect(await search('xyzzy plugh')).toEqual({ answeredBy: null, rows: [] });
		expect(await search('lightning bolt', { game: 'pokemon' })).toEqual({ answeredBy: null, rows: [] });
		expect(await search('pikachu', { game: 'pokemon' })).toMatchObject({ answeredBy: 'exact' });
		expect(ids(await search('ピカチュウ', { game: 'pokemon' }))).toEqual(['prt-pokemon-sv2a-25']);
	});

	it('issues the whole cascade as one round trip', async () => {
		let batches = 0;
		let statements = 0;
		const counting = {
			prepare: env.DB.prepare.bind(env.DB),
			batch: <T>(list: D1PreparedStatement[]) => {
				batches += 1;
				statements += list.length;
				return env.DB.batch<T>(list);
			},
		};
		await searchPrintings(counting, magic, { q: 'lughtning bolt', inStock: false, facets: {}, limit: 20, offset: 0 });
		expect(batches).toBe(1);
		expect(statements).toBe(5);
	});

	it('narrows every tier by the in-stock filter and reports what is held', async () => {
		const db = createDb(env.DB);
		await recordAdjustment(db, { printingId: 'prt-magic-m10-146', condition: 'NM', language: 'en', change: { delta: 3 }, reason: 'found' }, STAFF_ACTOR);
		await recordAdjustment(db, { printingId: 'prt-magic-m10-146', condition: 'LP', language: 'en', change: { delta: 1 }, reason: 'found' }, STAFF_ACTOR);

		const held = await search('lightning bolt', { inStock: true });
		expect(held.answeredBy).toBe('exact');
		expect(held.rows).toEqual([expect.objectContaining({ printingId: 'prt-magic-m10-146', held: 4 })]);
		expect(ids(await search('lughtning bolt', { inStock: true }))).toEqual(['prt-magic-m10-146']);
		expect((await search('lightning bolt')).rows.map(r => r.held)).toEqual([0, 4, 0, 0, 0, 0]);
		expect(await search('serra angel', { inStock: true })).toEqual({ answeredBy: null, rows: [] });
	});

	it('applies Facet predicates: set and rarity, a text Facet, and a flag Facet as contains-any', async () => {
		expect(ids(await search('lightning bolt', { facets: { rarity: ['uncommon'] } }))).toEqual(['prt-magic-sta-105-etched', 'prt-magic-sta-42']);
		expect(ids(await search('lightning bolt', { facets: { set: ['m10'] } }))).toEqual(['prt-magic-m10-146', 'prt-magic-m10-146-foil']);
		expect(ids(await search('lightning bolt', { facets: { finish: ['foil', 'etched'] } }))).toEqual(['prt-magic-m10-146-foil', 'prt-magic-sta-105-etched']);
		expect(ids(await search('lightning', { facets: { colour_identity: ['W'] } }))).toEqual(['prt-magic-sta-12']);
		expect(ids(await search('lughtning bolt', { facets: { colour_identity: ['R', 'G'] } }))).toEqual(BOLTS);
		expect(ids(await search('pikachu', { game: 'pokemon', facets: { variant: ['reverse_holo'] } }))).toEqual(['prt-pokemon-sv3pt5-25-rh']);
	});

	it('browses by the filters alone when no name is typed, paged', async () => {
		const page = await search('', { facets: { card_type: ['instant'] }, limit: 5, offset: 0 });
		expect(page.answeredBy).toBe('browse');
		expect(ids(page)).toEqual(BOLTS.slice(0, 5));
		expect(ids(await search('', { facets: { card_type: ['instant'] }, limit: 5, offset: 5 }))).toEqual(['prt-magic-sta-42', 'prt-magic-sta-12']);
	});
});
