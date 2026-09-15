import { execFileSync } from 'node:child_process';
import { expect, test } from '@nuxt/test-utils/playwright';
import { STAFF_NAV } from '../../app/utils/staff-nav';
import { E2E_STAFF_LOGIN } from '../support/staff-login';
import { signInAsStaff } from './support';

test.describe('staff sign-in and the sidebar shell (spec §7.1, §8.1)', () => {
	test('a signed-out visit to any staff page lands on /login', async ({ page }) => {
		await page.goto('/inventory');

		await expect(page).toHaveURL(/\/login$/);
		await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
	});

	test('a wrong password is refused on the login page', async ({ page, goto }) => {
		await goto('/login', { waitUntil: 'hydration' });
		await page.getByRole('textbox', { name: 'Email' }).fill(E2E_STAFF_LOGIN.email);
		await page.getByRole('textbox', { name: 'Password' }).fill('not the password');
		await page.getByRole('button', { name: 'Sign in' }).click();

		await expect(page.getByText('Wrong email or password')).toBeVisible();
		await expect(page).toHaveURL(/\/login$/);
	});

	test('signing in lands on Lookup inside the shell with every §8.1 nav item', async ({ page, goto }) => {
		await signInAsStaff({ page, goto });

		const nav = page.getByRole('navigation', { name: 'Staff navigation' });
		await expect(nav.getByRole('link')).toHaveText(STAFF_NAV.map(item => item.label));
		for (const item of STAFF_NAV) {
			await expect(nav.getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
		}
	});

	test('every nav item opens its page', async ({ page, goto }) => {
		await signInAsStaff({ page, goto });
		for (const item of STAFF_NAV.slice(1)) {
			await page.getByRole('navigation', { name: 'Staff navigation' }).getByRole('link', { name: item.label }).click();
			await expect(page).toHaveURL(new RegExp(`${item.to}$`));
		}
	});

	test('a signed-in visit to /login goes to Lookup', async ({ page, goto }) => {
		await signInAsStaff({ page, goto });
		await page.goto('/login');

		await expect(page).toHaveURL(/\/$/);
	});

	test('/ focuses the page search box, Cmd+K opens the palette and Esc closes it', async ({ page, goto }) => {
		await signInAsStaff({ page, goto });

		await page.keyboard.press('/');
		await expect(page.getByRole('textbox', { name: 'Search' })).toBeFocused();
		await page.getByRole('textbox', { name: 'Search' }).blur();

		// Nuxt UI binds `meta_k` to Ctrl on any UA that is not a Macintosh,
		// and Playwright's Desktop Chrome profile reports Linux.
		await page.keyboard.press('Control+k');
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toBeHidden();
	});

	test('revoking the session row logs the user out on the next request', async ({ page, goto, baseURL }) => {
		await signInAsStaff({ page, goto });
		expect((await page.request.get(`${baseURL}api/staff/health`)).status()).toBe(200);

		execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'shop-keepr', '--local', '--command', 'DELETE FROM session'], { stdio: 'pipe' });

		expect((await page.request.get(`${baseURL}api/staff/health`)).status()).toBe(401);
		await page.goto('/inventory');
		await expect(page).toHaveURL(/\/login$/);
	});

	test('signing out returns to /login and drops the session', async ({ page, goto, baseURL }) => {
		await signInAsStaff({ page, goto });
		await page.getByRole('button', { name: 'Sign out' }).click();

		await expect(page).toHaveURL(/\/login$/);
		expect((await page.request.get(`${baseURL}api/staff/health`)).status()).toBe(401);
	});
});
