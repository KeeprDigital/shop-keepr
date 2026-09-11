import type { H3Event } from 'h3';
import { createDb } from '../db/client';

/** The request's Drizzle handle over the D1 binding. */
export function useDb(event: H3Event) {
	const binding = event.context.cloudflare?.env?.DB;
	if (!binding) {
		throw apiError('INTERNAL', undefined, 'D1 binding DB is not available');
	}
	return createDb(binding);
}
