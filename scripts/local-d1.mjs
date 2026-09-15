/**
 * The D1 under `.wrangler/state` that `pnpm dev`, `pnpm db:migrate` and
 * `wrangler dev` share, reached from Node through wrangler's platform
 * proxy, with the repo's TypeScript modules loaded through jiti.
 */
import { createJiti } from 'jiti';
import { getPlatformProxy } from 'wrangler';

export const jiti = createJiti(import.meta.url);

/**
 * Runs `fn` with the local bindings, then disposes the proxy.
 * `persist: false` gives an empty in-memory D1 instead.
 */
export async function withLocalBindings(fn, { persist = true } = {}) {
	const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist });
	try {
		return await fn(proxy.env);
	}
	finally {
		await proxy.dispose();
	}
}
