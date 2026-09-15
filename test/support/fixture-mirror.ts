/**
 * The committed Catalogue fixture walked into the test D1, for db tests
 * that need a filled Mirror rather than a hand-seeded row. Bundled at
 * build time (`import.meta.glob`): workerd has no filesystem.
 */
import type { CataloguePage, Cursor, PrintingRecord } from '../../server/catalogue/generated/types.gen';
import type { SyncOutcome, SyncRunSummary } from '../../server/catalogue/sync/run';
import type { FixturePages } from './fixture-fetch';
import { env } from 'cloudflare:test';
import { createCatalogueClient, FIRST_CURSOR } from '../../server/catalogue/client';
import { runCatalogueSync } from '../../server/catalogue/sync/run';
import { fixtureFetchFrom } from './fixture-fetch';

const baseURL = 'https://catalogue.test/api';
const credential = 'shop-keepr-test-key';

export const committedPages: FixturePages = new Map(Object.entries(import.meta.glob('../fixtures/catalogue/**/*.json', { eager: true, import: 'default' }))
	.map(([path, body]) => [path.replace('../fixtures/catalogue/', ''), body]));

/** The cursor the committed Magic walk ends on. */
export const LAST_MAGIC_CURSOR = 'magic-0044';

/** A committed Printing record, by id. */
export function fixturePrinting(id: string): PrintingRecord {
	for (const [path, body] of committedPages) {
		if (!path.includes('/catalogue/')) {
			continue;
		}
		const found = (body as CataloguePage).records.find((r): r is PrintingRecord => r.kind === 'printing' && r.id === id);
		if (found) {
			return found;
		}
	}
	throw new Error(`No fixture Printing ${id}`);
}

/** `base` with `records` served as the one page of `game` after `after`, for a delta walk. */
export function deltaPages(game: string, records: { cursor: Cursor }[], after: Cursor, base: FixturePages = committedPages): FixturePages {
	const pages = new Map(base);
	const next = records.at(-1)!.cursor;
	pages.set(`games/${game}/catalogue/${after}.json`, { records, next_cursor: next, has_more: false });
	pages.set(`games/${game}/catalogue/${next}.json`, { records: [], next_cursor: next, has_more: false });
	return pages;
}

let tick = 1_800_000_000_000;

/** One Catalogue run of `game` against `pages`; a full walk unless told to resume from the stored cursor. */
export async function syncFixture(game: string, { pages = committedPages, from = 'zero' }: { pages?: FixturePages; from?: 'zero' | 'stored' } = {}): Promise<SyncRunSummary> {
	const client = createCatalogueClient({ fetch: fixtureFetchFrom(pages, { baseURL, credential }), baseURL, credential });
	const outcome: SyncOutcome = await runCatalogueSync({ db: env.DB, client, game, fromCursor: from === 'zero' ? FIRST_CURSOR : undefined, now: () => (tick += 1_000) });
	if (!outcome.claimed) {
		throw new Error('run was refused');
	}
	return outcome.run;
}
