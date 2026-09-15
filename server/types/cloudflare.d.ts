// The Cloudflare bindings Nitro attaches to every request under the
// Cloudflare preset, typed from the generated worker-configuration.d.ts at
// the repo root (`pnpm cf:types`). Absent under any other preset.
declare module 'h3' {
	interface H3EventContext {
		cloudflare?: {
			env: Env;
			context: ExecutionContext;
			request: Request;
		};
	}
}

declare global {
	// Set per environment as secrets (`wrangler secret put`), or in
	// `.dev.vars` locally; `wrangler types` only sees them when that file
	// exists, so they are declared here too (ADR 0013).
	interface Env {
		/** The Catalogue API root for this environment, without a trailing slash. */
		CATALOGUE_BASE_URL: string;
		/** This environment's Catalogue API key; shop-keepr is Consumer #1. */
		CATALOGUE_CREDENTIAL: string;
	}
}

export {};
