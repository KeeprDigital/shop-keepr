/**
 * The API surfaces (spec §7.1, _Route protection_; ADR 0015). A route is
 * reachable only through the surface it is placed on; an `/api` path that
 * matches none is unreachable, whatever handler Nitro may have for it.
 */
export type Surface
	/** `/api/staff/**`: accepts only a staff session. */
	= | 'staff'
	/** `/api/kiosk/**`: accepts only a kiosk key. */
		| 'kiosk'
	/** Reachable without a credential. */
		| 'open'
	/** An `/api` path placed on no surface: denied. */
		| 'none'
	/** Not an API path: pages and assets, gated by the app's route middleware. */
		| 'page';

/** Longest prefix wins; every entry ends in `/` so `/api/staffing` never matches `/api/staff`. */
const PLACEMENTS: ReadonlyArray<readonly [prefix: string, surface: Surface]> = [
	// Better Auth's own handler: sign-in, sign-out, get-session.
	['/api/auth/', 'open'],
	// Nuxt Icon's icon data, public by nature.
	['/api/_nuxt_icon/', 'open'],
	['/api/staff/', 'staff'],
	['/api/kiosk/', 'kiosk'],
];

export function resolveSurface(path: string): Surface {
	const pathname = path.split('?', 1)[0]!;
	if (pathname !== '/api' && !pathname.startsWith('/api/')) {
		return 'page';
	}
	for (const [prefix, surface] of PLACEMENTS) {
		if (pathname.startsWith(prefix)) {
			return surface;
		}
	}
	return 'none';
}
