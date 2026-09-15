import type { test } from '@nuxt/test-utils/playwright';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { E2E_STAFF_LOGIN } from '../support/staff-login';

type Goto = Parameters<Parameters<typeof test>[2]>[0]['goto'];

/**
 * Signs in through the login page and waits for Lookup. Waits for
 * hydration first: a value typed into the server-rendered form before Vue
 * takes over is lost when it does.
 */
export async function signInAsStaff({ page, goto }: { page: Page; goto: Goto }, login = E2E_STAFF_LOGIN) {
	await goto('/login', { waitUntil: 'hydration' });
	await page.getByRole('textbox', { name: 'Email' }).fill(login.email);
	await page.getByRole('textbox', { name: 'Password' }).fill(login.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'Lookup' })).toBeVisible();
}
