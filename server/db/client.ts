import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

/** What every D1 caller here actually needs, Drizzle's driver included; a D1 Session provides both. */
export type D1Client = Pick<D1Database, 'prepare' | 'batch'>;

/**
 * Drizzle over the D1 binding. Every request opens a D1 Session
 * (`withSession`, spec §4.1) so reads stay consistent with the writes the
 * same request made even if read replication is ever switched on.
 */
export function createDb(binding: D1Database) {
	return createDbOn(binding.withSession('first-primary'));
}

/** Drizzle over a Session already open, so code that writes its own SQL and code that uses Drizzle share one. */
export function createDbOn(session: D1Client) {
	return drizzle(session as D1Database, { schema, casing: 'snake_case' });
}

export type Db = ReturnType<typeof createDb>;
