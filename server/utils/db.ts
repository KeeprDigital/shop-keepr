import type { H3Event } from 'h3';
import type { D1Client } from '../db/client';
import { createDb } from '../db/client';

/** The request's Drizzle handle over the D1 binding. */
export function useDb(event: H3Event) {
	return createDb(useD1Binding(event));
}

/** The request's D1 Session, for code that writes its own SQL (search). */
export function useD1(event: H3Event): D1Client {
	return useD1Binding(event).withSession('first-primary');
}

function useD1Binding(event: H3Event): D1Database {
	const binding = event.context.cloudflare?.env?.DB;
	if (!binding) {
		throw apiError('INTERNAL', { message: 'D1 binding DB is not available' });
	}
	return binding;
}
