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

	compatibilityDate: '2025-07-15',
});
