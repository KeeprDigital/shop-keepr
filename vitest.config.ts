import { defineVitestConfig } from '@nuxt/test-utils/config';

export default defineVitestConfig({
	test: {
		include: ['test/unit/**/*.{test,spec}.ts'],
		environment: 'nuxt',
		environmentOptions: {
			nuxt: {
				domEnvironment: 'happy-dom',
			},
		},
		coverage: {
			provider: 'v8',
			include: ['app/**'],
		},
	},
});
