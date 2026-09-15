import { toWebRequest } from 'h3';
import { useAuth } from '../../auth/instance';

/** Better Auth's own routes: sign-in, sign-out, get-session (spec §7.1). */
export default defineEventHandler(async (event) => {
	const auth = await useAuth();
	return auth.handler(toWebRequest(event));
});
