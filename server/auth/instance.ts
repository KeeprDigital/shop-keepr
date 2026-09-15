/**
 * The Worker's one Better Auth instance, built at module scope from the
 * bindings (`cloudflare:workers`; Nitro shims the import in dev). Its
 * `$context` is initialised eagerly here rather than on the first request:
 * a promise first created inside a request that the client then aborts is
 * never settled by workerd, and Better Auth caches it, which would hang
 * every later auth call in the isolate (better-auth#10315, ADR 0015).
 *
 * A missing `BETTER_AUTH_SECRET` does not stop the Worker booting (pages
 * and assets still serve, and the db test project loads this module
 * without one); every auth call fails instead, with the reason.
 */
import { env } from 'cloudflare:workers';
import { createAuth } from './auth';

const secret = env.BETTER_AUTH_SECRET;

export const auth = createAuth({ db: env.DB, secret: secret || 'unset' });

/** Awaited before any use of `auth`; rejects when the secret is missing. */
export const authReady: Promise<unknown> = secret
	? auth.$context
	: Promise.reject(new Error('BETTER_AUTH_SECRET is not set; add it to .dev.vars locally or `wrangler secret put` it'));

// The rejection is for the awaiters, not the isolate.
authReady.catch(() => {});
