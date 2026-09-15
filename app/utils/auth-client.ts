import { createAuthClient } from 'better-auth/vue';

/**
 * The staff session on the client (spec §7.1): Better Auth's Vue client
 * against the Worker's own `/api/auth` handler, same origin, so the
 * session cookie rides along and nothing is stored in page script.
 */
export const authClient = createAuthClient();
