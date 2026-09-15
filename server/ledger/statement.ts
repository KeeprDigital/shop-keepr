import type { SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';

const dialect = new SQLiteAsyncDialect();

/**
 * A `sql` template as the bound D1 statement `batch()` takes. Drizzle's
 * own `batch()` cannot carry a raw statement, and the guarded writes the
 * ledger needs (`INSERT … SELECT … WHERE EXISTS`) are raw by nature.
 */
export function prepared(db: Db, statement: SQL): D1PreparedStatement {
	const { sql: text, params } = dialect.sqlToQuery(statement);
	return db.$client.prepare(text).bind(...params);
}
