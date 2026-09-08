/**
 * Throwaway spike for issue #25 item 2. Run from the repo root with:
 *   node_modules/.bin/vitest run --config spike/d1-trigram/vitest.config.ts \
 *     --reporter=verbose --disable-console-intercept
 * (--disable-console-intercept is what surfaces the measurement numbers.)
 */
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	root: here,
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
	test: {
		include: ['**/*.test.ts'],
		testTimeout: 1_800_000,
		hookTimeout: 1_800_000,
	},
});
