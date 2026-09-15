import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAuth, provisionStaffLogin, runAuthMigrations } from '../../server/auth/auth';

const SECRET = 'test-secret-at-least-thirty-two-characters-long';
const LOGIN = { email: 'counter@example.test', password: 'correct horse battery staple' };

function createTestAuth() {
	return createAuth({ db: env.DB, secret: SECRET });
}

async function signIn(auth: ReturnType<typeof createTestAuth>, password = LOGIN.password) {
	const { headers } = await auth.api.signInEmail({
		body: { email: LOGIN.email, password },
		returnHeaders: true,
	});
	return headers;
}

/** The request headers a browser would send back after `Set-Cookie`. */
function cookieFrom(response: Headers): Headers {
	const cookie = response.getSetCookie().map(line => line.split(';', 1)[0]!).join('; ');
	return new Headers({ cookie });
}

describe('staff auth against D1', () => {
	beforeEach(async () => {
		const auth = createTestAuth();
		await runAuthMigrations(auth);
		await provisionStaffLogin(auth, LOGIN);
	});

	it('signs the shared login in and answers with a session cookie', async () => {
		const auth = createTestAuth();
		const response = await signIn(auth);

		expect(response.getSetCookie().some(line => /HttpOnly/i.test(line))).toBe(true);
		const session = await auth.api.getSession({ headers: cookieFrom(response) });
		expect(session?.user.email).toBe(LOGIN.email);
	});

	it('rejects a wrong password', async () => {
		await expect(signIn(createTestAuth(), 'wrong')).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
	});

	it('has no sign-up route: the shared login is provisioned, never registered', async () => {
		const auth = createTestAuth();
		await expect(auth.api.signUpEmail({
			body: { name: 'Anyone', email: 'anyone@example.test', password: 'long enough password' },
		})).rejects.toMatchObject({ status: 'BAD_REQUEST' });
	});

	it('logs the user out on the next request once the session row is revoked', async () => {
		const auth = createTestAuth();
		const cookie = cookieFrom(await signIn(auth));
		expect(await auth.api.getSession({ headers: cookie })).not.toBeNull();

		await env.DB.prepare('DELETE FROM session').run();

		expect(await auth.api.getSession({ headers: cookie })).toBeNull();
	});

	it('provisioning again resets the password and revokes existing sessions', async () => {
		const auth = createTestAuth();
		const cookie = cookieFrom(await signIn(auth));

		await provisionStaffLogin(auth, { email: LOGIN.email, password: 'a new shared password' });

		expect(await auth.api.getSession({ headers: cookie })).toBeNull();
		await expect(signIn(auth)).rejects.toMatchObject({ status: 'UNAUTHORIZED' });
		const fresh = await signIn(auth, 'a new shared password');
		expect(fresh.getSetCookie().length).toBeGreaterThan(0);
	});

	it('runs the auth migrations idempotently', async () => {
		const auth = createTestAuth();
		await runAuthMigrations(auth);
		const tables = await env.DB.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').bind('table').all<{ name: string }>();
		const names = tables.results.map(row => row.name);
		expect(names).toEqual(expect.arrayContaining(['user', 'session', 'account', 'verification']));
	});
});
