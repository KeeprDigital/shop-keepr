import { fileURLToPath } from 'node:url';

export default defineNuxtConfig({
	modules: [
		'@nuxt/eslint',
		'@vueuse/nuxt',
		'@nuxt/ui',
		'@nuxt/test-utils',
	],

	eslint: {
		config: {
			standalone: false,
		},
	},

	css: ['~/assets/css/main.css'],

	// Icons ship in the bundles, so the Worker never fetches icon data at
	// runtime and the page never calls /api/_nuxt_icon for one it uses.
	icon: {
		serverBundle: { collections: ['lucide'] },
		clientBundle: { scan: true, sizeLimitKb: 256 },
	},

	devtools: {
		enabled: true,
	},

	// One Worker (spec §2). In dev, Nitro's cloudflare-dev preset proxies the
	// bindings in wrangler.jsonc through wrangler, so `pnpm dev` talks to a
	// local D1 under .wrangler/state.
	nitro: {
		preset: 'cloudflare-module',
		typescript: {
			// `wrangler types` output: the Env interface and D1 globals for
			// server code. The app project picks it up as a root `*.d.ts`.
			tsConfig: { include: ['../worker-configuration.d.ts'] },
		},
	},

	// The built Worker also exports the Workflow class the binding names;
	// dev keeps Nitro's own entry.
	$production: {
		nitro: {
			entry: fileURLToPath(new URL('./server/entry.cloudflare.ts', import.meta.url)),
		},
	},

	compatibilityDate: '2025-07-15',
});
