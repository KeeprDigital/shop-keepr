import type { H3Event } from 'h3';
import type { Surface } from '../../shared/domain/ledger';

/** Who is writing the ledger: the audit pair every entry carries (spec §3, `ledger_entry`; §7.1). */
export interface Actor {
	surface: Surface;
	/** The Better Auth session: one shift on one terminal. */
	sessionId: string;
	/** Null until per-staff login. */
	staffUserId: string | null;
}

/** The staff session the surface middleware admitted the request with. */
export function staffActor(event: H3Event): Actor {
	const principal = event.context.staff;
	if (!principal) {
		throw apiError('UNAUTHENTICATED', { message: 'Staff session required' });
	}
	return { surface: 'staff', sessionId: principal.session.id, staffUserId: null };
}
