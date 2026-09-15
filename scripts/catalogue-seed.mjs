/**
 * Fills the local D1 Mirror (spec §5, _Observability and operations_): the
 * same Catalogue run the Workflow performs, driven inline against the D1
 * under `.wrangler/state` that `pnpm dev` and `pnpm db:migrate` use.
 *
 *   pnpm catalogue:seed                       every Game System in the committed fixture
 *   pnpm catalogue:seed --from staging --game magic --game pokemon
 *   pnpm catalogue:seed --resume              a delta from the stored cursor instead of a full walk
 *
 * `--from staging` reads CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL from
 * the environment or `.dev.vars` (ADR 0013). Production is never a target.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { createJiti } from 'jiti';
import { getPlatformProxy } from 'wrangler';

const { values } = parseArgs({
	options: {
		from: { type: 'string', default: 'fixture' },
		game: { type: 'string', multiple: true },
		resume: { type: 'boolean', default: false },
	},
});

const jiti = createJiti(import.meta.url);
const { createCatalogueClient, FIRST_CURSOR } = await jiti.import('../server/catalogue/client.ts');
const { runCatalogueSync } = await jiti.import('../server/catalogue/sync/run.ts');

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
	const baseURL = (process.env.CATALOGUE_BASE_URL || env.CATALOGUE_BASE_URL || '').replace(/\/$/, '');
	const credential = process.env.CATALOGUE_CREDENTIAL || env.CATALOGUE_CREDENTIAL;
	if (!baseURL || !credential) {
		throw new Error('Set CATALOGUE_BASE_URL and CATALOGUE_CREDENTIAL (environment or .dev.vars) to Catalogue staging.');
	}
	if (!values.game?.length) {
		throw new Error('Pass --game <code> for each Game System to walk from staging.');
	}
	return { client: createCatalogueClient({ fetch, baseURL, credential }), games: [] };
}

const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: true });
try {
	const source = values.from === 'staging' ? stagingSource(proxy.env) : await fixtureSource();
	const games = values.game?.length ? values.game : source.games;
	for (const game of games) {
		const outcome = await runCatalogueSync({ db: proxy.env.DB, client: source.client, game, fromCursor: values.resume ? undefined : FIRST_CURSOR });
		if (!outcome.claimed) {
			console.error(`${game}: refused, a run is already ${outcome.reason}`);
			process.exitCode = 1;
			continue;
		}
		const { status, cursorFrom, cursorTo, counts } = outcome.run;
		console.log(`${game}: ${status} (${cursorFrom} -> ${cursorTo}) seen ${counts.seen}, written ${counts.written}, quarantined ${counts.quarantined}, drifted ${counts.drifted}`);
	}
}
finally {
	await proxy.dispose();
}
