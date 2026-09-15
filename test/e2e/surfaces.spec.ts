import { expect, test } from '@nuxt/test-utils/playwright';

test.describe('API surfaces (spec §7.1, route protection)', () => {
	test('an unauthenticated request to a staff route is rejected', async ({ request, baseURL }) => {
		const response = await request.get(`${baseURL}api/staff/health`);

		expect(response.status()).toBe(401);
		expect(await response.json()).toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
	});

	test('a kiosk route admits no credential yet', async ({ request, baseURL }) => {
		const response = await request.get(`${baseURL}api/kiosk/baskets`);

		expect(response.status()).toBe(401);
	});

	test('an API path on no surface is unreachable', async ({ request, baseURL }) => {
		const response = await request.get(`${baseURL}api/_nuxt_icon/../staff/health`);
		const stray = await request.get(`${baseURL}api/health`);

		expect(stray.status()).toBe(404);
		expect(await stray.json()).toMatchObject({ data: { code: 'NOT_FOUND' } });
		expect([401, 404]).toContain(response.status());
	});

	test('the Better Auth handler is open', async ({ request, baseURL }) => {
		const response = await request.get(`${baseURL}api/auth/get-session`);

		expect(response.status()).toBe(200);
		expect(await response.json()).toBeNull();
	});
});
