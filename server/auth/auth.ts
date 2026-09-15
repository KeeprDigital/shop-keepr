/**
 * Better Auth for the staff identity (spec §7.1, ADR 0015): email + password
 * against a DB-backed session with `cookieCache` off, so deleting the
 * `session` row revokes it on the next request. The auth tables live in the
 * same D1 database as the application schema, through Better Auth's own
 * Kysely/D1 path rather than the Drizzle adapter, and are migrated
 * programmatically by `runAuthMigrations`.
 *
 * This module is pure construction: no binding is read at import, so tests
 * and scripts build an instance over whatever D1 they hold. The Worker's
 * singleton lives in `./instance.ts`.
 */
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';

export interface AuthOptions {
	db: D1Database;
	/** `BETTER_AUTH_SECRET`; signs the session cookie. */
	secret: string;
}

export function createAuth({ db, secret }: AuthOptions) {
	return betterAuth({
		database: db,
		secret,
		emailAndPassword: {
			enabled: true,
			// The shared login is provisioned (`provisionStaffLogin`), never
			// registered; there is no sign-up surface.
			disableSignUp: true,
		},
		session: {
			// Off, so revocation is immediate: every request reads the row.
			cookieCache: { enabled: false },
		},
		advanced: {
			database: {
				// Auth tables keep Better Auth's own id scheme; the ULID rule
				// (spec §4.1) is for the application schema.
				generateId: 'uuid',
				// Better Auth would otherwise introspect D1 as soon as the
				// context initialises, which the eager module-scope init
				// (`./instance.ts`) turns into I/O outside a request: workerd
				// refuses it and an error is logged on every isolate boot.
				// The tables are ours to migrate (`runAuthMigrations`).
				validateSchema: false,
			},
		},
	});
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * What it would take to bring the auth tables (`user`, `session`,
 * `account`, `verification`) up to the options: the plan, its SQL, and
 * `runMigrations` to apply it. Programmatic because the Better Auth CLI
 * cannot reach D1.
 */
export function planAuthMigrations(auth: Auth) {
	return getMigrations(auth.options);
}

/** Applies the plan. Idempotent: an up-to-date database is a no-op. */
export async function runAuthMigrations(auth: Auth): Promise<void> {
	const { runMigrations } = await planAuthMigrations(auth);
	await runMigrations();
}

export interface StaffLogin {
	email: string;
	password: string;
}

/**
 * Sets the one shared store login (spec §7.1): creates the `user` and its
 * credential account, or resets the password of the existing one. Either
 * way every session the login holds is revoked, so a password change logs
 * every counter out.
 */
export async function provisionStaffLogin(auth: Auth, { email, password }: StaffLogin): Promise<{ userId: string }> {
	const ctx = await auth.$context;
	const hash = await ctx.password.hash(password);
	const existing = await ctx.internalAdapter.findUserByEmail(email);
	if (existing) {
		await ctx.internalAdapter.updatePassword(existing.user.id, hash);
		await ctx.internalAdapter.deleteUserSessions(existing.user.id);
		return { userId: existing.user.id };
	}
	const user = await ctx.internalAdapter.createUser({ email, name: 'Store', emailVerified: true }, { method: 'email-password' });
	await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash });
	return { userId: user.id };
}
