/**
 * The D1 the scripts drive from Node through wrangler's platform proxy,
 * with the repo's TypeScript modules loaded through jiti. By default the
 * local one under `.wrangler/state` that `pnpm dev`, `pnpm db:migrate` and
 * `wrangler dev` share; with `remote: true`, the real database named in
 * wrangler.jsonc, over the account wrangler is logged in to.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createJiti } from 'jiti';
import { getPlatformProxy, unstable_readConfig } from 'wrangler';

export const jiti = createJiti(import.meta.url);

/**
 * A config that names only the D1 binding, flagged remote, so the proxy
 * connects to the production database instead of emulating one.
 */
function remoteBindingsConfig() {
	const config = unstable_readConfig({ config: 'wrangler.jsonc' }, { hideWarnings: true });
	const path = '.wrangler/tmp/remote-bindings.json';
	mkdirSync('.wrangler/tmp', { recursive: true });
	writeFileSync(path, JSON.stringify({
		name: config.name,
		compatibility_date: config.compatibility_date,
		compatibility_flags: config.compatibility_flags,
		d1_databases: config.d1_databases.map(db => ({ ...db, remote: true })),
	}));
	return path;
}

/**
 * Runs `fn` with the bindings, then disposes the proxy.
 * `persist: false` gives an empty in-memory D1 instead of the local one.
 */
export async function withLocalBindings(fn, { persist = true, remote = false } = {}) {
	const proxy = await getPlatformProxy({ configPath: remote ? remoteBindingsConfig() : 'wrangler.jsonc', persist });
	try {
		return await fn(proxy.env);
	}
	finally {
		await proxy.dispose();
	}
}
