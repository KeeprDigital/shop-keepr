import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** What Drizzle's D1 driver actually calls; a D1 Session provides both. */
type D1Client = Pick<D1Database, 'prepare' | 'batch'>;

/**
 * Drizzle over the D1 binding. Every request opens a D1 Session
 * (`withSession`, spec §4.1) so reads stay consistent with the writes the
 * same request made even if read replication is ever switched on.
 */
export function createDb(binding: D1Database) {
	const session: D1Client = binding.withSession('first-primary');
	return drizzle(session as D1Database, { schema, casing: 'snake_case' });
}

export type Db = ReturnType<typeof createDb>;
