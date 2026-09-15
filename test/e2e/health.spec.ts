import { expect, test } from '@nuxt/test-utils/playwright';
import { STORE_ID } from '../../server/utils/store';

test('the staff health route reads the Store from D1', async ({ request, baseURL }) => {
	const response = await request.get(`${baseURL}api/staff/health`);

	expect(response.status()).toBe(200);
	const body = await response.json();
	expect(body.ok).toBe(true);
	expect(body.store).toEqual({ id: STORE_ID, name: 'shop-keepr' });
	expect(body.checkedAt).toBeGreaterThan(1_700_000_000_000);
});
