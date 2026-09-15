/**
 * A `fetch` that serves Catalogue pages held in memory, keyed by their
 * fixture path (`games/{game}/{walk}/{cursor}.json`). Portable: no Node
 * imports, so the db project can use it inside workerd. The Node-side
 * `fixtureFetch` in `catalogue-fixture.ts` reads the committed files into
 * this.
 */

export type FixturePages = ReadonlyMap<string, unknown>;

function problem(status: number, title: string): Response {
	return new Response(JSON.stringify({ title, status }), {
		status,
		headers: { 'content-type': 'application/problem+json' },
	});
}

/**
 * `GET {baseURL}/games/{game}/{walk}?cursor={cursor}` answers with the page
 * at `games/{game}/{walk}/{cursor}.json`. It demands the given bearer
 * credential, as the Catalogue does.
 */
export function fixtureFetchFrom(pages: FixturePages, { baseURL, credential }: { baseURL: string; credential: string }): typeof fetch {
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
		const body = pages.get(`games/${match[1]}/${match[2]}/${cursor}.json`);
		if (body === undefined) {
			return problem(404, 'not_found');
		}
		return Response.json(body);
	};
}
