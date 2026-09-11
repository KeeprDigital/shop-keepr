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

	compatibilityDate: '2025-07-15',
});
