import { auth, authReady } from '../auth/instance';
import { resolveSurface } from '../auth/surface';

/**
 * Places every API request on its surface (spec §7.1, _Route protection_).
 * Staff routes admit only a staff session; kiosk routes admit only a kiosk
 * key, which no ticket has minted yet, so they admit nothing; an `/api`
 * path on no surface does not exist, whatever handler sits behind it.
 */
export default defineEventHandler(async (event) => {
	const surface = resolveSurface(event.path);
	switch (surface) {
		case 'page':
		case 'open':
			return;
		case 'none':
			throw apiError('NOT_FOUND');
		case 'kiosk':
			throw apiError('UNAUTHENTICATED', { message: 'No kiosk key' });
		case 'staff': {
			await authReady;
			const principal = await auth.api.getSession({ headers: event.headers });
			if (!principal) {
				throw apiError('UNAUTHENTICATED', { message: 'Staff session required' });
			}
			event.context.staff = principal;
		}
	}
});
