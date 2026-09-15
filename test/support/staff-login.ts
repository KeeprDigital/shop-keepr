/**
 * The shared store login the e2e runner seeds into the local D1 before
 * `wrangler dev` starts (playwright.config.ts) and signs in with.
 */
export const E2E_STAFF_LOGIN = {
	email: 'counter@shop-keepr.test',
	password: 'e2e counter password',
} as const;

/** The cookie-signing secret `wrangler dev` runs with under the e2e runner. */
export const E2E_AUTH_SECRET = 'e2e-only-Kq7vX2pL9mZ4tR8wB3nY6cJ1hF5sD0gA-not-for-any-deployed-environment';
