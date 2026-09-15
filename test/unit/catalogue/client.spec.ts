import { describe, expect, it } from 'vitest';
import { CatalogueRequestError, createCatalogueClient } from '../../../server/catalogue/client';
import { fixtureFetch } from '../../support/catalogue-fixture';

const credential = 'shop-keepr-test-key';
const baseURL = 'https://catalogue.test/api';

function client(fetch: typeof globalThis.fetch = fixtureFetch({ credential })) {
	return createCatalogueClient({ fetch, baseURL, credential });
}

describe('catalogue client', () => {
	it('walks a Game System from cursor zero to the end', async () => {
		const catalogue = client();
		const first = await catalogue.walkCatalogue('magic', '0');
		expect(first.hasMore).toBe(true);
		expect(first.nextCursor).toBe('magic-0027');
		expect(first.records.every(r => r.ok)).toBe(true);
		expect(first.records.map(r => r.ok && r.record.kind)).toContain('set');

		const second = await catalogue.walkCatalogue('magic', first.nextCursor);
		expect(second.hasMore).toBe(false);
		expect(second.records.map(r => r.ok && r.record.kind)).toContain('printing');

		const quiet = await catalogue.walkCatalogue('magic', second.nextCursor);
		expect(quiet).toEqual({ records: [], nextCursor: second.nextCursor, hasMore: false });
	});

	it('walks Market Price movements on their own cursor', async () => {
		const page = await client().walkMarketPrices('pokemon', '0');
		expect(page.hasMore).toBe(false);
		expect(page.records).toHaveLength(5);
		expect(page.records[0]).toMatchObject({ ok: true, record: { printing_id: 'prt-pokemon-base1-58', market_price: { amount: 325, currency: 'USD' } } });
	});

	it('identifies itself with the credential', async () => {
		const wrongKey = createCatalogueClient({ fetch: fixtureFetch({ credential }), baseURL, credential: 'someone-else' });
		await expect(wrongKey.walkCatalogue('magic', '0')).rejects.toBeInstanceOf(CatalogueRequestError);
		await expect(wrongKey.walkCatalogue('magic', '0')).rejects.toMatchObject({ status: 401, problem: { title: 'authentication_required' } });
	});

	it('surfaces a failed request with its status', async () => {
		await expect(client().walkCatalogue('no-such-game', '0')).rejects.toMatchObject({ status: 404 });
	});

	it('hands back a record that fails validation with its raw payload, and keeps the rest', async () => {
		const broken = { kind: 'printing', id: 'prt-broken' };
		const set = { kind: 'set', cursor: 'x-0002', game: 'x', code: 'x', name: 'X', released_on: null };
		const page = await client(async () => Response.json({ records: [broken, set], next_cursor: 'x-0002', has_more: false })).walkCatalogue('x', '0');
		expect(page.records).toHaveLength(2);
		expect(page.records[0]).toMatchObject({ ok: false, raw: broken });
		expect(page.records[0]!.ok === false && page.records[0]!.issues.length).toBeGreaterThan(0);
		expect(page.records[1]).toEqual({ ok: true, record: set });
	});

	it('refuses a page whose envelope is not the contract', async () => {
		await expect(client(async () => Response.json({ items: [] })).walkCatalogue('x', '0')).rejects.toBeInstanceOf(CatalogueRequestError);
	});
});
