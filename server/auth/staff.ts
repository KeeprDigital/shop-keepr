import type { Auth } from './auth';

/** The staff session a request on the staff surface was admitted with. */
export type StaffPrincipal = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

declare module 'h3' {
	interface H3EventContext {
		/** Set by the surface middleware on every request it admits to `/api/staff/**`. */
		staff?: StaffPrincipal;
	}
}
