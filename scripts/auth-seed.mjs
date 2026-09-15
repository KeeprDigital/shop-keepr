/**
 * Sets the one shared store login in the local D1 (spec §7.1): creates it,
 * or resets its password and revokes every session it holds.
 *
 *   pnpm auth:seed --email counter@example.test --password 'correct horse battery staple'
 *
 * Production has no script yet; the staff Settings page will own this once
 * per-staff users arrive (ADR 0015).
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { createJiti } from 'jiti';
import { getPlatformProxy } from 'wrangler';

const { values } = parseArgs({
	options: {
		email: { type: 'string' },
		password: { type: 'string' },
	},
});
if (!values.email || !values.password) {
	console.error('Usage: pnpm auth:seed --email <email> --password <password>');
	process.exit(1);
}

const jiti = createJiti(import.meta.url);
const { createAuth, provisionStaffLogin, runAuthMigrations } = await jiti.import('../server/auth/auth.ts');

const proxy = await getPlatformProxy({ configPath: 'wrangler.jsonc', persist: true });
try {
	const auth = createAuth({ db: proxy.env.DB, secret: 'unused-while-provisioning' });
	await runAuthMigrations(auth);
	const { userId } = await provisionStaffLogin(auth, { email: values.email, password: values.password });
	console.log(`staff login ${values.email} set (user ${userId}); every existing session revoked`);
}
finally {
	await proxy.dispose();
}
