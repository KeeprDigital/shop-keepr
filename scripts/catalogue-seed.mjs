/**
 * Fills the local D1 Mirror (spec §5, _Observability and operations_): the
 * same Catalogue run the Workflow performs, driven inline against the D1
 * under `.wrangler/state` that `pnpm dev` and `pnpm db:migrate` use.
 *
 *   pnpm catalogue:seed                       every Game System in the committed fixture
 *   pnpm catalogue:seed --from staging --game magic --game pokemon
 *   pnpm catalogue:seed --resume              a delta from the stored cursor instead of a full walk
 *   pnpm catalogue:seed --kind market_price   the Market Price walk instead of the Catalogue walk
 *
 * `--from staging` reads CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL from
 * the environment or `.dev.vars` (ADR 0013). Production is never a target.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { jiti, withLocalBindings } from './local-d1.mjs';

const { values } = parseArgs({
	options: {
		from: { type: 'string', default: 'fixture' },
		game: { type: 'string', multiple: true },
		resume: { type: 'boolean', default: false },
		kind: { type: 'string', default: 'catalogue' },
	},
});
if (!['catalogue', 'market_price'].includes(values.kind)) {
	throw new Error(`--kind must be catalogue or market_price, got ${values.kind}`);
}

const { createCatalogueClient, FIRST_CURSOR } = await jiti.import('../server/catalogue/client.ts');
const { buildMirrorIndexes, runCatalogueSync, runMarketPriceSync } = await jiti.import('../server/catalogue/sync/run.ts');
const { catalogueCredentials } = await jiti.import('../server/catalogue/credentials.ts');

/** The committed fixture, served by path, for every Game System it holds. */
async function fixtureSource() {
	const { fixtureFetch, readFixturePages } = await jiti.import('../test/support/catalogue-fixture.ts');
	const baseURL = 'https://catalogue.fixture';
	const credential = 'fixture';
	const games = [...new Set(readFixturePages().map(page => /^games\/([^/]+)\/catalogue\//.exec(page.path)?.[1]).filter(Boolean))];
	return { client: createCatalogueClient({ fetch: fixtureFetch({ baseURL, credential }), baseURL, credential }), games };
}

/** Catalogue staging over HTTPS as Consumer #1; the Game Systems must be named. */
function stagingSource(env) {
	if (!values.game?.length) {
		throw new Error('Pass --game <code> for each Game System to walk from staging.');
	}
	const { baseURL, credential } = catalogueCredentials({
		CATALOGUE_BASE_URL: process.env.CATALOGUE_BASE_URL || env.CATALOGUE_BASE_URL,
		CATALOGUE_CREDENTIAL: process.env.CATALOGUE_CREDENTIAL || env.CATALOGUE_CREDENTIAL,
	});
	return { client: createCatalogueClient({ fetch, baseURL, credential }), games: [] };
}

await withLocalBindings(async (env) => {
	const source = values.from === 'staging' ? stagingSource(env) : await fixtureSource();
	const games = values.game?.length ? values.game : source.games;
	for (const game of games) {
		const run = values.kind === 'market_price' ? runMarketPriceSync : runCatalogueSync;
		const outcome = await run({ db: env.DB, client: source.client, game, fromCursor: values.resume ? undefined : FIRST_CURSOR });
		if (!outcome.claimed) {
			console.error(`${game}: refused, a run is already ${outcome.reason}`);
			process.exitCode = 1;
			continue;
		}
		const { status, cursorFrom, cursorTo, counts } = outcome.run;
		console.log(`${game} ${values.kind}: ${status} (${cursorFrom} -> ${cursorTo}) seen ${counts.seen}, written ${counts.written}, quarantined ${counts.quarantined}, drifted ${counts.drifted}, skipped ${counts.skipped}`);
	}
	// A seed leaves the indexes for after every Game System is in (spec §4.5).
	if (values.kind === 'catalogue') {
		await buildMirrorIndexes(env.DB);
	}
});
