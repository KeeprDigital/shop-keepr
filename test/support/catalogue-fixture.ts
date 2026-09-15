import type { CatalogueRecord, PrintingRecord } from '../../server/catalogue/generated/types.gen';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { zCataloguePage } from '../../server/catalogue/generated/zod.gen';
import { fixtureFetchFrom } from './fixture-fetch';

/** The committed Catalogue fixture (ADR 0013): one JSON file per walked page. */
export const FIXTURE_DIR = join(process.cwd(), 'test/fixtures/catalogue');

/** Every fixture page as `{ path, body }`, path relative to the fixture root. */
export function readFixturePages(): { path: string; body: unknown }[] {
	const pages: { path: string; body: unknown }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
			}
			else if (name.endsWith('.json')) {
				pages.push({ path: relative(FIXTURE_DIR, full), body: JSON.parse(readFileSync(full, 'utf8')) });
			}
		}
	};
	walk(FIXTURE_DIR);
	return pages;
}

/** A `fetch` that serves the committed fixture by path (see `fixture-fetch.ts`). */
export function fixtureFetch(options: { baseURL: string; credential: string }): typeof fetch {
	return fixtureFetchFrom(new Map(readFixturePages().map(page => [page.path, page.body])), options);
}

/** Every Catalogue record the fixture holds, in walk order, parsed. */
export function fixtureRecords(): CatalogueRecord[] {
	return readFixturePages()
		.filter(page => page.path.includes('/catalogue/'))
		.flatMap(page => zCataloguePage.parse(page.body).records);
}

export function fixturePrintings(): PrintingRecord[] {
	return fixtureRecords().filter(r => r.kind === 'printing');
}
