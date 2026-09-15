import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

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

function problem(status: number, title: string): Response {
	return new Response(JSON.stringify({ title, status }), {
		status,
		headers: { 'content-type': 'application/problem+json' },
	});
}

/**
 * A `fetch` that serves the committed fixture by path: `GET {baseURL}/games/
 * {game}/{walk}?cursor={cursor}` reads `games/{game}/{walk}/{cursor}.json`.
 * It demands the given bearer credential, as the Catalogue does.
 */
export function fixtureFetch({ baseURL, credential }: { baseURL: string; credential: string }): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (!url.href.startsWith(`${baseURL}/`)) {
			return problem(404, 'not_found');
		}
		if (request.headers.get('authorization') !== `Bearer ${credential}`) {
			return problem(401, 'authentication_required');
		}
		const match = /^\/games\/([^/]+)\/(catalogue|market-prices)$/.exec(url.href.slice(baseURL.length).split('?')[0]!);
		const cursor = url.searchParams.get('cursor');
		if (!match || !cursor || request.method !== 'GET') {
			return problem(404, 'not_found');
		}
		const file = join(FIXTURE_DIR, 'games', match[1]!, match[2]!, `${cursor}.json`);
		try {
			return new Response(readFileSync(file, 'utf8'), { headers: { 'content-type': 'application/json' } });
		}
		catch {
			return problem(404, 'not_found');
		}
	};
}
