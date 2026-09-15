import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineVitestProject } from '@nuxt/test-utils/config';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * `unit` runs in the Nuxt environment; `db` runs inside workerd against a
 * fresh local D1 with the committed migrations applied. Routes under
 * `server/api` are covered only by the e2e runner (spec §9).
 */
const unit = await defineVitestProject({
	test: {
		name: 'unit',
		include: ['test/unit/**/*.{test,spec}.ts'],
		environment: 'nuxt',
		environmentOptions: {
			nuxt: {
				domEnvironment: 'happy-dom',
			},
		},
	},
});

const migrations = await readD1Migrations(`${root}server/db/migrations`);

export default defineConfig({
	test: {
		projects: [
			unit,
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: `${root}wrangler.jsonc` },
						miniflare: {
							bindings: {
								TEST_MIGRATIONS: migrations,
							},
						},
					}),
				],
				test: {
					name: 'db',
					include: ['test/db/**/*.{test,spec}.ts'],
					setupFiles: ['./test/db/setup.ts'],
				},
			},
		],
		coverage: {
			provider: 'v8',
			include: ['app/**', 'server/**', 'shared/**'],
		},
	},
});
