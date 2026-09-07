/**
 * Throwaway spike for issue #4. Run from this directory with:
 *   ../../node_modules/.bin/vitest run --config ./vitest.config.ts \
 *     --reporter=verbose --disable-console-intercept
 * (--disable-console-intercept is what surfaces the measurement numbers.)
 */
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		include: ['**/*.test.ts'],
		testTimeout: 600_000,
		hookTimeout: 600_000,
	},
});
