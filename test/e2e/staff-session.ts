import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { E2E_STAFF_LOGIN } from '../support/staff-login';

/**
 * Opens a page and waits for Vue to take over, the way test-utils' `goto`
 * with `waitUntil: 'hydration'` does. A value typed into the
 * server-rendered form before that is lost when it does.
 */
export async function gotoHydrated(page: Page, path: string) {
	await page.goto(path);
	await page.waitForFunction(() => window.useNuxtApp?.().isHydrating === false);
}

/** Signs in through the login page with the seeded store login and waits for Lookup. */
export async function signInAsStaff(page: Page) {
	await gotoHydrated(page, '/login');
	await page.getByRole('textbox', { name: 'Email' }).fill(E2E_STAFF_LOGIN.email);
	await page.getByRole('textbox', { name: 'Password' }).fill(E2E_STAFF_LOGIN.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByRole('heading', { name: 'Lookup' })).toBeVisible();
}
