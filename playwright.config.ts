import type { ConfigOptions } from '@nuxt/test-utils/playwright';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E_AUTH_SECRET, E2E_STAFF_LOGIN } from './test/support/staff-login';

// The e2e runner exercises the real Worker: `pnpm build` under the Cloudflare
// preset, migrations applied to the local D1 (Drizzle's and Better Auth's),
// the shared store login seeded, then `wrangler dev` serving the built
// output under workerd. Tests point at that server via `host`.
const host = 'http://127.0.0.1:8787';

const command = [
	'pnpm build',
	'pnpm db:migrate',
	`pnpm auth:seed --email ${E2E_STAFF_LOGIN.email} --password '${E2E_STAFF_LOGIN.password}'`,
	`pnpm exec wrangler dev --port 8787 --var BETTER_AUTH_SECRET:${E2E_AUTH_SECRET}`,
].join(' && ');

export default defineConfig<ConfigOptions>({
	testDir: './test/e2e',
	webServer: {
		command,
		url: `${host}/login`,
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
