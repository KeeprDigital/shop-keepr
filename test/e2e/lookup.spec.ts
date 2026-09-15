import type { Page } from '@playwright/test';
import { expect, test } from '@nuxt/test-utils/playwright';
import { signInAsStaff } from './staff-session';

function rows(page: Page, text: string) {
	return page.getByLabel('Results').getByRole('row').filter({ hasText: text });
}

async function pickGame(page: Page, game: string) {
	await page.getByRole('combobox', { name: 'Game System' }).click();
	await page.getByRole('option', { name: game }).click();
}

test.describe('Lookup search (spec §4.3, §8.2)', () => {
	test('finds a card by a partial, mistyped or unaccented name inside one Game System', async ({ page }) => {
		await signInAsStaff(page);
		await pickGame(page, 'magic');

		const search = page.getByRole('textbox', { name: 'Search' });
		await search.fill('bolt lightning');
		await expect(rows(page, 'Lightning Bolt')).toHaveCount(6);
		await expect(rows(page, 'Lightning Bolt').filter({ hasText: 'Withdrawn' })).toHaveCount(1);

		await search.fill('lughtning bolt');
		await expect(rows(page, 'Lightning Bolt')).toHaveCount(6);
		await expect(page.getByText('Showing the closest names.')).toBeVisible();

		await search.fill('xyzzy plugh');
		await expect(page.getByText('Nothing found in this game')).toBeVisible();

		await pickGame(page, 'pokemon');
		await search.fill('lightning bolt');
		await expect(page.getByText('Nothing found in this game')).toBeVisible();
		await search.fill('pikachu');
		await expect(rows(page, 'Pikachu')).toHaveCount(3);
	});

	test('narrows by a Facet whose values come from the vocabulary, and by stock', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await pickGame(page, 'magic');
		await page.getByRole('textbox', { name: 'Search' }).fill('lightning bolt');
		await expect(rows(page, 'Lightning Bolt')).toHaveCount(6);

		await page.getByRole('button', { name: 'Finish' }).click();
		await page.getByRole('option', { name: 'Etched foil' }).click();
		await page.keyboard.press('Escape');
		await expect(rows(page, 'Lightning Bolt')).toHaveCount(1);
		await expect(rows(page, 'Lightning Bolt')).toContainText('STA');

		const options = await page.request.get(`${baseURL}api/staff/search/options?game=magic`);
		expect(await options.json()).toMatchObject({ facets: expect.arrayContaining([expect.objectContaining({ facet: 'rarity', values: expect.arrayContaining([{ code: 'mythic', name: 'Mythic Rare' }]) })]) });

		await page.request.post(`${baseURL}api/staff/adjustments`, { data: { printingId: 'prt-magic-sta-42', condition: 'NM', language: 'en', change: { newCount: 2 }, reason: 'miscount' } });
		await page.getByRole('button', { name: 'Finish' }).click();
		await page.getByRole('option', { name: 'Etched foil' }).click();
		await page.keyboard.press('Escape');
		await page.getByRole('switch', { name: 'In stock' }).click();
		// Other specs may leave other Bolts held; what matters is that every row shown is held and #42 is among them.
		await expect(rows(page, 'Lightning Bolt').filter({ hasText: '#42' })).toHaveCount(1);
		await expect(rows(page, 'Lightning Bolt').filter({ hasText: '#42' })).toContainText('2');
		await expect(rows(page, 'Lightning Bolt').filter({ hasText: 'none held' })).toHaveCount(0);
	});
});
