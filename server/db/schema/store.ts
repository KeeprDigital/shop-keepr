import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { epochMs, language, ulid } from '../columns';

/**
 * The Store: the business shop-keepr runs for. One today, hardcoded
 * (`STORE_ID`), with `store_id` on every other table from day one. Settings
 * (Default Tender, Tender Modifier, Hold expiry period, Pricing Rules) arrive with
 * their own tickets; this is the row the health check reads.
 */
export const store = sqliteTable('store', {
	id: ulid().primaryKey(),
	name: text().notNull(),
	/** ISO 4217 code of the one trading currency Money is counted in. */
	currency: text().notNull(),
	/** The Language a SKU takes when staff set none (ADR 0002). */
	defaultLanguage: language().notNull(),
	createdAt: epochMs().notNull(),
	updatedAt: epochMs().notNull(),
});
