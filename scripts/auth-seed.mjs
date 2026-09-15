/**
 * Sets the one shared store login (spec §7.1): creates it, or resets its
 * password and revokes every session it holds.
 *
 *   pnpm auth:seed --email counter@example.test --password 'correct horse battery staple'
 *   pnpm auth:seed --remote --email … --password …    the production database
 *
 * The staff Settings page will own this once per-staff users arrive
 * (ADR 0015); until then this is how the login is set anywhere.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { jiti, withLocalBindings } from './local-d1.mjs';

const { values } = parseArgs({
	options: {
		email: { type: 'string' },
		password: { type: 'string' },
		remote: { type: 'boolean', default: false },
	},
});
if (!values.email || !values.password) {
	console.error('Usage: pnpm auth:seed --email <email> --password <password>');
	process.exit(1);
}

const { createAuth, provisionStaffLogin, runAuthMigrations } = await jiti.import('../server/auth/auth.ts');

await withLocalBindings(async (env) => {
	// Nothing is signed here; a long placeholder keeps Better Auth's secret warnings quiet.
	const auth = createAuth({ db: env.DB, secret: 'unused-while-provisioning-nothing-is-signed-here' });
	await runAuthMigrations(auth);
	const { userId } = await provisionStaffLogin(auth, { email: values.email, password: values.password });
	console.log(`staff login ${values.email} set (user ${userId}) ${values.remote ? 'in the production database' : 'locally'}; every existing session revoked`);
}, { remote: values.remote });
