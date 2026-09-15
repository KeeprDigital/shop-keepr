import type { ConfigOptions } from '@nuxt/test-utils/playwright';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { E2E_AUTH_SECRET, E2E_STAFF_LOGIN } from './test/support/staff-login';

// The e2e runner exercises the real Worker: `pnpm build` under the Cloudflare
// preset, migrations applied to the local D1, the Mirror filled from the
// committed Catalogue fixture, the shared store login seeded, then
// `wrangler dev` serving the built output under workerd.
const host = 'http://127.0.0.1:8787';

const command = [
	'pnpm build',
	'pnpm catalogue:seed',
	'pnpm auth:seed --email "$E2E_STAFF_EMAIL" --password "$E2E_STAFF_PASSWORD"',
	'pnpm exec wrangler dev --port 8787 --var "BETTER_AUTH_SECRET:$E2E_AUTH_SECRET"',
].join(' && ');

export default defineConfig<ConfigOptions>({
	testDir: './test/e2e',
	// Every spec shares the one local D1 and the one store login, and the
	// auth spec revokes sessions outright; files cannot run side by side.
	workers: 1,
	webServer: {
		command,
		env: {
			E2E_STAFF_EMAIL: E2E_STAFF_LOGIN.email,
			E2E_STAFF_PASSWORD: E2E_STAFF_LOGIN.password,
			E2E_AUTH_SECRET,
		},
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
