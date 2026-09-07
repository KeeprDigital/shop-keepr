import { expect, test } from '@nuxt/test-utils/playwright';

test('serves the home page', async ({ page, goto }) => {
	await goto('/', { waitUntil: 'hydration' });

	await expect(page.locator('body')).toBeVisible();
});
