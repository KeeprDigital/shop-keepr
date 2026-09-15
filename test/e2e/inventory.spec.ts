import type { Page } from '@playwright/test';
import { expect, test } from '@nuxt/test-utils/playwright';
import { signInAsStaff } from './staff-session';

/** A fixture Printing the store holds for these tests: Charizard, Base Set 4. */
const CHARIZARD = { printingId: 'prt-pokemon-base1-4', condition: 'NM', language: 'en' } as const;

/**
 * Sets the count from whatever an earlier run left, through the same write
 * path the modal uses. A count already held is refused as nothing to
 * record, which is the state wanted.
 */
async function setCount(page: Page, baseURL: string, newCount: number, key = CHARIZARD) {
	const response = await page.request.post(`${baseURL}api/staff/adjustments`, {
		data: { ...key, change: { newCount }, reason: 'miscount' },
	});
	if (response.status() !== 200) {
		expect(await response.json()).toMatchObject({ data: { code: 'VALIDATION_FAILED' } });
	}
}

function charizardRow(page: Page) {
	return page.getByRole('row').filter({ hasText: 'Charizard' }).filter({ hasText: 'NM' });
}

test.describe('Inventory and the Adjust modal (spec §8.2)', () => {
	test('lists held SKUs with Printing, Condition, Language and on-hand, and drops a SKU at zero', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 3);
		await setCount(page, baseURL!, 0, { ...CHARIZARD, condition: 'HP' });

		await page.goto('/inventory');

		const row = charizardRow(page);
		await expect(row).toHaveCount(1);
		await expect(row).toContainText('BASE1');
		await expect(row).toContainText('#4');
		await expect(row.getByRole('cell').nth(1)).toHaveText('NM');
		await expect(row.getByRole('cell').nth(2)).toHaveText('en');
		await expect(row.getByRole('cell').nth(3)).toHaveText('3');
		await expect(page.getByRole('row').filter({ hasText: 'Charizard' }).filter({ hasText: 'HP' })).toHaveCount(0);
	});

	test('filters by Game System and by name', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 2);
		await setCount(page, baseURL!, 1, { printingId: 'prt-magic-ptc-161', condition: 'LP', language: 'en' });

		await page.goto('/inventory');
		await page.getByRole('textbox', { name: 'Search' }).fill('chariz');
		await expect(charizardRow(page)).toHaveCount(1);
		await expect(page.getByRole('row').filter({ hasText: 'Pikachu' })).toHaveCount(0);

		await page.getByRole('textbox', { name: 'Search' }).fill('');
		await page.getByRole('combobox', { name: 'Game System' }).click();
		await page.getByRole('option', { name: 'pokemon' }).click();
		await expect(charizardRow(page)).toHaveCount(1);
		await expect(page.getByRole('row').filter({ hasText: 'Lightning Bolt' })).toHaveCount(0);
	});

	test('a withdrawn Printing with stock stays listed with a badge', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 1, { printingId: 'prt-magic-ptc-161', condition: 'LP', language: 'en' });
		await page.goto('/inventory');

		const row = page.getByRole('row').filter({ hasText: 'Lightning Bolt' }).filter({ hasText: 'PTC' });
		await expect(row).toHaveCount(1);
		await expect(row.getByText('Withdrawn')).toBeVisible();
	});

	test('the Adjust modal records a change from the row and the table shows the new on-hand', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 3);
		await page.goto('/inventory');

		await charizardRow(page).getByRole('button', { name: 'Adjust' }).click();
		const modal = page.getByRole('dialog', { name: 'Adjust stock' });
		await expect(modal).toContainText('Charizard');
		await expect(modal).toContainText('3 on hand');
		await modal.getByRole('spinbutton', { name: 'Change by' }).fill('-1');
		await modal.getByRole('combobox', { name: 'Reason' }).click();
		await page.getByRole('option', { name: 'Damage' }).click();
		await modal.getByRole('textbox', { name: 'Note' }).fill('Bent corner');
		await modal.getByRole('button', { name: 'Record Adjustment' }).click();

		await expect(modal).toBeHidden();
		await expect(charizardRow(page).getByRole('cell').nth(3)).toHaveText('2');
	});

	test('the Adjust modal refuses to take stock below zero and leaves the count alone', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 2);
		await page.goto('/inventory');

		await charizardRow(page).getByRole('button', { name: 'Adjust' }).click();
		const modal = page.getByRole('dialog', { name: 'Adjust stock' });
		await modal.getByRole('spinbutton', { name: 'Change by' }).fill('-5');
		await modal.getByRole('combobox', { name: 'Reason' }).click();
		await page.getByRole('option', { name: 'Shrinkage' }).click();
		await modal.getByRole('button', { name: 'Record Adjustment' }).click();

		await expect(modal).toContainText('Only 2 on hand');
		await modal.getByRole('button', { name: 'Cancel' }).click();
		await expect(charizardRow(page).getByRole('cell').nth(3)).toHaveText('2');
	});

	test('a regrade moves copies to another Condition as a second row', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 3);
		await setCount(page, baseURL!, 0, { ...CHARIZARD, condition: 'MP' });
		await page.goto('/inventory');

		await charizardRow(page).getByRole('button', { name: 'Adjust' }).click();
		const modal = page.getByRole('dialog', { name: 'Adjust stock' });
		await modal.getByRole('radio', { name: 'Regrade' }).click();
		await modal.getByRole('spinbutton', { name: 'Regrade' }).fill('1');
		await modal.getByRole('combobox', { name: 'Now in Condition' }).click();
		await page.getByRole('option', { name: 'Moderately Played (MP)' }).click();
		await modal.getByRole('button', { name: 'Record Adjustment' }).click();

		await expect(modal).toBeHidden();
		await expect(charizardRow(page).getByRole('cell').nth(3)).toHaveText('2');
		await expect(page.getByRole('row').filter({ hasText: 'Charizard' }).filter({ hasText: 'MP' }).getByRole('cell').nth(3)).toHaveText('1');
	});

	test('the System page runs the reconcile on demand', async ({ page, baseURL }) => {
		await signInAsStaff(page);
		await setCount(page, baseURL!, 1);
		await page.goto('/system');

		await page.getByRole('button', { name: 'Reconcile now' }).click();

		await expect(page.getByText(/all agree with the ledger/)).toBeVisible();
	});
});
