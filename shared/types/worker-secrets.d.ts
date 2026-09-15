// The Worker's secrets: set per environment with `wrangler secret put`, or in
// `.dev.vars` locally. `wrangler types` only sees them when that file exists,
// so they are declared here (ADR 0013). `Env` is what a request carries;
// `Cloudflare.Env` is what `cloudflare:workers` exports at module scope;
// both are the same bindings. Lives under shared/ because Nuxt's app and
// server TypeScript projects both include it, and the app project reaches
// server code through Nitro's route types.
declare global {
	interface WorkerSecrets {
		/** The Catalogue API root for this environment, without a trailing slash. */
		CATALOGUE_BASE_URL: string;
		/** This environment's Catalogue API key; shop-keepr is Consumer #1. */
		CATALOGUE_CREDENTIAL: string;
		/** Signs the staff session cookie (spec §7.1); a secret, never in wrangler.jsonc. */
		BETTER_AUTH_SECRET: string;
	}
	interface Env extends WorkerSecrets {}
	namespace Cloudflare {
		interface Env extends WorkerSecrets {}
	}
}

export {};
