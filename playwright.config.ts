import type { ConfigOptions } from '@nuxt/test-utils/playwright';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The e2e runner exercises the real Worker: `pnpm build` under the Cloudflare
// preset, migrations applied to the local D1, then `wrangler dev` serving
// the built output under workerd. Tests point at that server via `host`.
const host = 'http://127.0.0.1:8787';

export default defineConfig<ConfigOptions>({
	testDir: './test/e2e',
	webServer: {
		command: 'pnpm build && pnpm db:migrate && pnpm exec wrangler dev --port 8787',
		url: `${host}/api/staff/health`,
		timeout: 240_000,
		reuseExistingServer: !process.env.CI,
		stdout: 'ignore',
		stderr: 'pipe',
	},
	use: {
		nuxt: {
			rootDir: fileURLToPath(new URL('.', import.meta.url)),
			host,
		},
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
