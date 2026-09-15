import type { H3Event } from 'h3';
import type { Auth } from './auth';

/** The staff session a request on the staff surface was admitted with. */
export type StaffPrincipal = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

declare module 'h3' {
	interface H3EventContext {
		staff?: StaffPrincipal;
	}
}

/** The staff session behind a request that passed the staff guard. */
export function useStaff(event: H3Event): StaffPrincipal {
	if (!event.context.staff) {
		throw apiError('UNAUTHENTICATED');
	}
	return event.context.staff;
}
