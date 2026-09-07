import type { ConfigOptions } from '@nuxt/test-utils/playwright';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

export default defineConfig<ConfigOptions>({
	testDir: './test/e2e',
	use: {
		nuxt: {
			rootDir: fileURLToPath(new URL('.', import.meta.url)),
		},
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});
