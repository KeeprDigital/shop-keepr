import type { CataloguePage, Cursor, PrintingRecord } from '../../server/catalogue/generated/types.gen';
import type { SyncOutcome } from '../../server/catalogue/sync/run';
import type { FixturePages } from '../support/fixture-fetch';
import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createCatalogueClient, FIRST_CURSOR } from '../../server/catalogue/client';
import { claimRun, runCatalogueSync } from '../../server/catalogue/sync/run';
import { createDb } from '../../server/db/client';
import { catalogueQuarantine, printing, printingDetail, syncRun } from '../../server/db/schema';
import { fixtureFetchFrom } from '../support/fixture-fetch';

const baseURL = 'https://catalogue.test/api';
const credential = 'shop-keepr-test-key';

// The committed fixture, bundled at build time: workerd has no filesystem.
const committed: FixturePages = new Map(Object.entries(import.meta.glob('../fixtures/catalogue/**/*.json', { eager: true, import: 'default' }))
	.map(([path, body]) => [path.replace('../fixtures/catalogue/', ''), body]));

const LAST_MAGIC_CURSOR = 'magic-0044';

function catalogueRecords(pages: FixturePages, path: string): unknown[] {
	return (pages.get(path) as CataloguePage).records;
}

/** `base` with one Magic Printing rewritten wherever it appears, for a full walk that finds it changed. */
function withPrinting(id: string, patch: (record: PrintingRecord) => unknown, base: FixturePages = committed): FixturePages {
	const pages = new Map(base);
	for (const [path, body] of pages) {
		if (path.startsWith('games/magic/catalogue/')) {
			const page = body as CataloguePage;
			pages.set(path, { ...page, records: page.records.map(r => (r.kind === 'printing' && r.id === id ? patch(r) : r)) });
		}
	}
	return pages;
}

/** `base` with `records` served as the one Magic page after `after`, for a delta walk. */
function delta(records: { cursor: Cursor }[], after: Cursor = LAST_MAGIC_CURSOR, base: FixturePages = committed): FixturePages {
	const pages = new Map(base);
	const next = records.at(-1)!.cursor;
	pages.set(`games/magic/catalogue/${after}.json`, { records, next_cursor: next, has_more: false });
	pages.set(`games/magic/catalogue/${next}.json`, { records: [], next_cursor: next, has_more: false });
	return pages;
}

function magicPrinting(id: string): PrintingRecord {
	return catalogueRecords(committed, 'games/magic/catalogue/magic-0027.json').find((r): r is PrintingRecord => (r as PrintingRecord).id === id)!;
}

let tick = 1_800_000_000_000;

/** One Catalogue run; `from` is a full walk unless told to resume from the stored cursor. */
function sync(pages: FixturePages = committed, { game = 'magic', from = 'zero' }: { game?: string; from?: 'zero' | 'stored' } = {}) {
	const client = createCatalogueClient({ fetch: fixtureFetchFrom(pages, { baseURL, credential }), baseURL, credential });
	return runCatalogueSync({ db: env.DB, client, game, fromCursor: from === 'zero' ? FIRST_CURSOR : undefined, now: () => (tick += 1_000) });
}

function completed(outcome: SyncOutcome) {
	if (!outcome.claimed) {
		throw new Error('run was refused');
	}
	return outcome.run;
}

const db = () => createDb(env.DB);
const bolt = 'prt-magic-m10-146';
const readBolt = () => db().query.printing.findFirst({ where: eq(printing.id, bolt) });

describe('the Catalogue walk (ADR 0009: seed, delta and reconcile are one run)', () => {
	it('seeds the Mirror from the fixture and records one completed run with counts', async () => {
		const run = completed(await sync());

		expect(run).toMatchObject({ kind: 'catalogue', gameSystem: 'magic', status: 'completed', cursorFrom: '0', cursorTo: LAST_MAGIC_CURSOR });
		expect(run.counts).toEqual({ seen: 44, written: 44, quarantined: 0, drifted: 0 });

		const rows = await db().query.printing.findMany();
		expect(rows).toHaveLength(17);
		expect(await db().query.printingDetail.findMany()).toHaveLength(17);
		expect(await db().query.catalogueSet.findMany()).toHaveLength(7);
		expect(await db().query.catalogueVocabulary.findMany()).toHaveLength(20);

		const row = rows.find(r => r.id === bolt)!;
		expect(row).toMatchObject({
			cardId: 'card-magic-lightning-bolt',
			gameSystem: 'magic',
			name: 'Lightning Bolt',
			setCode: 'm10',
			collectorNumber: '146',
			rarity: 'common',
			finish: 'nonfoil',
			marketPrice: 240,
			marketPriceCurrency: 'USD',
			marketPriceCursor: 'magic-price-0002',
			withdrawn: false,
			cursor: 'magic-0029',
		});
		expect(row.marketPriceUpdatedAt).toBe(row.syncedAt);
		expect(JSON.parse(row.images)).toEqual([{ face: 0, thumbnail: expect.stringContaining(bolt), full: expect.stringContaining(bolt) }]);

		const detail = await db().query.printingDetail.findFirst({ where: eq(printingDetail.printingId, bolt) });
		expect(JSON.parse(detail!.record)).toEqual(magicPrinting(bolt));

		const history = await db().query.syncRun.findMany();
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ id: run.id, status: 'completed', recordsSeen: 44, recordsWritten: 44, cursorFrom: '0', cursorTo: LAST_MAGIC_CURSOR });
		expect(history[0]!.finishedAt).not.toBeNull();
	});

	it('keeps a Printing with no Market Price unpriced and unwatermarked', async () => {
		await sync();
		const unpriced = await db().query.printing.findFirst({ where: eq(printing.id, 'prt-magic-m10-15') });
		expect(unpriced).toMatchObject({ marketPrice: null, marketPriceCurrency: null, marketPriceCursor: null, marketPriceUpdatedAt: null });
	});

	it('walks each Game System on its own cursor', async () => {
		await sync();
		const run = completed(await sync(committed, { game: 'pokemon' }));
		expect(run).toMatchObject({ gameSystem: 'pokemon', status: 'completed', cursorTo: 'pokemon-0028' });
		expect(run.counts).toEqual({ seen: 28, written: 28, quarantined: 0, drifted: 0 });
		expect(await db().query.printing.findMany()).toHaveLength(23);
	});

	it('writes nothing on a second full walk and records zero drift', async () => {
		const first = completed(await sync());
		const before = await db().query.printing.findMany();

		const again = completed(await sync());
		expect(again.id).not.toBe(first.id);
		expect(again).toMatchObject({ status: 'completed', cursorFrom: '0', cursorTo: LAST_MAGIC_CURSOR });
		expect(again.counts).toEqual({ seen: 44, written: 0, quarantined: 0, drifted: 0 });
		expect(await db().query.printing.findMany()).toEqual(before);
	});

	it('resumes a delta from the stored cursor and sees nothing new', async () => {
		await sync();
		const run = completed(await sync(committed, { from: 'stored' }));
		expect(run).toMatchObject({ status: 'completed', cursorFrom: LAST_MAGIC_CURSOR, cursorTo: LAST_MAGIC_CURSOR });
		expect(run.counts).toEqual({ seen: 0, written: 0, quarantined: 0, drifted: 0 });
	});

	it('applies a delta to exactly the row whose record changed', async () => {
		await sync();
		const before = new Map((await db().query.printing.findMany()).map(r => [r.id, r]));

		const run = completed(await sync(delta([{ ...magicPrinting(bolt), name: 'Lightning Bolt (misprint)', cursor: 'magic-0045' }]), { from: 'stored' }));
		expect(run).toMatchObject({ status: 'completed', cursorFrom: LAST_MAGIC_CURSOR, cursorTo: 'magic-0045' });
		expect(run.counts).toEqual({ seen: 1, written: 1, quarantined: 0, drifted: 0 });

		for (const row of await db().query.printing.findMany()) {
			if (row.id === bolt) {
				expect(row).toMatchObject({ name: 'Lightning Bolt (misprint)', cursor: 'magic-0045' });
				expect(row.syncedAt).toBeGreaterThan(before.get(bolt)!.syncedAt);
			}
			else {
				expect(row).toEqual(before.get(row.id));
			}
		}
		const detail = await db().query.printingDetail.findFirst({ where: eq(printingDetail.printingId, bolt) });
		expect(JSON.parse(detail!.record).name).toBe('Lightning Bolt (misprint)');
	});

	it('counts a change a full walk finds as drift, and still applies it', async () => {
		await sync();
		const run = completed(await sync(withPrinting(bolt, r => ({ ...r, rarity: 'uncommon' }))));
		expect(run.status).toBe('completed_with_drift');
		expect(run.counts).toEqual({ seen: 44, written: 1, quarantined: 0, drifted: 1 });
		expect(await readBolt()).toMatchObject({ rarity: 'uncommon' });
	});

	it('leaves a row alone when a record arrives behind the cursor it holds', async () => {
		await sync();
		const run = completed(await sync(withPrinting(bolt, r => ({ ...r, name: 'Stale Bolt', cursor: 'magic-0001' }))));
		expect(run.counts.written).toBe(0);
		expect(await readBolt()).toMatchObject({ name: 'Lightning Bolt', cursor: 'magic-0029' });
	});

	it('quarantines a malformed record and an unknown colour, and completes with drift', async () => {
		const purple = withPrinting('prt-magic-m10-58', r => ({ ...r, attributes: { ...r.attributes, colour_identity: ['U', 'P'] } }));
		const { card_id: _dropped, ...malformed } = magicPrinting(bolt);
		const pages = withPrinting(bolt, () => malformed, purple);

		const run = completed(await sync(pages));
		expect(run.status).toBe('completed_with_drift');
		expect(run.counts).toEqual({ seen: 44, written: 42, quarantined: 2, drifted: 0 });

		const quarantined = (await db().query.catalogueQuarantine.findMany())
			.map(q => ({ ...q, raw: JSON.parse(q.raw), detail: JSON.parse(q.detail) }));
		expect(quarantined).toHaveLength(2);
		expect(quarantined).toEqual(expect.arrayContaining([
			expect.objectContaining({ syncRunId: run.id, kind: 'catalogue', gameSystem: 'magic', recordKind: 'printing', recordId: bolt, cursor: 'magic-0029', reason: 'validation_failed', raw: malformed, detail: { issues: expect.any(Array) } }),
			expect.objectContaining({ syncRunId: run.id, recordId: 'prt-magic-m10-58', reason: 'unknown_facet_value', detail: { facet: 'colour_identity', value: 'P' } }),
		]));
		expect(await db().query.printing.findMany()).toHaveLength(15);
		expect(await db().query.syncRun.findFirst({ where: eq(syncRun.id, run.id) })).toMatchObject({ status: 'completed_with_drift', recordsQuarantined: 2 });
	});

	it('clears an earlier run\'s quarantine once a full walk reads the record cleanly', async () => {
		const first = completed(await sync(withPrinting(bolt, r => ({ ...r, attributes: { ...r.attributes, colour_identity: ['P'] } }))));
		expect(first.counts.quarantined).toBe(1);

		const second = completed(await sync());
		expect(second.status).toBe('completed');
		expect(second.counts).toMatchObject({ quarantined: 0, written: 1 });
		expect(await db().query.catalogueQuarantine.findMany({ where: eq(catalogueQuarantine.syncRunId, first.id) })).toEqual([]);
		expect(await readBolt()).toMatchObject({ name: 'Lightning Bolt' });
	});

	it('flips the withdrawn flag and keeps the row', async () => {
		const ptc = 'prt-magic-ptc-161';
		await sync(withPrinting(ptc, r => ({ ...r, withdrawn: false })));
		expect(await db().query.printing.findFirst({ where: eq(printing.id, ptc) })).toMatchObject({ withdrawn: false });

		const run = completed(await sync(delta([{ ...magicPrinting(ptc), cursor: 'magic-0045' }]), { from: 'stored' }));
		expect(run.counts.written).toBe(1);
		expect(await db().query.printing.findFirst({ where: eq(printing.id, ptc) })).toMatchObject({ withdrawn: true, name: 'Lightning Bolt' });
		expect(await db().query.printing.findMany()).toHaveLength(17);
	});

	it('never overwrites a good Market Price with null', async () => {
		await sync();
		const before = (await readBolt())!;

		await sync(delta([{ ...magicPrinting(bolt), market_price: null, market_price_cursor: null, cursor: 'magic-0045' }]), { from: 'stored' });
		expect(await readBolt()).toMatchObject({ marketPrice: 240, marketPriceCurrency: 'USD', marketPriceCursor: 'magic-price-0002', marketPriceUpdatedAt: before.marketPriceUpdatedAt, cursor: 'magic-0045' });
	});

	it('moves the watermark only when the Market Price moved', async () => {
		await sync();
		const before = (await readBolt())!;

		await sync(delta([{ ...magicPrinting(bolt), name: 'Lightning Bolt!', cursor: 'magic-0045' }]), { from: 'stored' });
		expect(await readBolt()).toMatchObject({ name: 'Lightning Bolt!', marketPriceUpdatedAt: before.marketPriceUpdatedAt });

		await sync(delta([{ ...magicPrinting(bolt), market_price: { amount: 260, currency: 'USD' }, market_price_cursor: 'magic-price-0099', cursor: 'magic-0046' }], 'magic-0045'), { from: 'stored' });
		const moved = (await readBolt())!;
		expect(moved).toMatchObject({ marketPrice: 260, marketPriceCursor: 'magic-price-0099' });
		expect(moved.marketPriceUpdatedAt).toBeGreaterThan(before.marketPriceUpdatedAt!);
	});

	it('refuses a second run while one is running, and abandons a stale one', async () => {
		const held = await claimRun(env.DB, { kind: 'catalogue', game: 'magic', fromCursor: FIRST_CURSOR, now: tick });
		expect(held.claimed).toBe(true);

		expect(await sync(committed, { game: 'pokemon' })).toEqual({ claimed: false, reason: 'running' });

		tick += 3 * 60 * 60 * 1_000;
		const run = completed(await sync());
		expect(run.status).toBe('completed');
		expect((await db().query.syncRun.findMany()).map(r => r.status).sort()).toEqual(['abandoned', 'completed']);
	});

	it('builds the Mirror indexes after the walk', async () => {
		await sync();
		const { results } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'printing'`).all<{ name: string }>();
		expect(results.map(r => r.name)).toEqual(expect.arrayContaining(['printing_card', 'printing_game_set_number']));
	});
});
