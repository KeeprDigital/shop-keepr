import { toWebRequest } from 'h3';
import { auth, authReady } from '../../auth/instance';

/** Better Auth's own routes: sign-in, sign-out, get-session (spec §7.1). */
export default defineEventHandler(async (event) => {
	await authReady;
	return auth.handler(toWebRequest(event));
});
