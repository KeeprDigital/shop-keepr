/**
 * Staff pages are login-gated (spec §8.1, _Shell_): without a session every
 * page goes to `/login`, and `/login` with one goes to Lookup. The kiosk
 * (`/kiosk/**`) carries its own credential and arrives with its own ticket.
 */
export default defineNuxtRouteMiddleware(async (to) => {
	if (to.path.startsWith('/kiosk')) {
		return;
	}
	const { data: session } = await authClient.useSession(useFetch);
	const signedIn = session.value !== null && session.value !== undefined;
	if (to.path === '/login') {
		return signedIn ? navigateTo('/') : undefined;
	}
	if (!signedIn) {
		return navigateTo('/login');
	}
});
