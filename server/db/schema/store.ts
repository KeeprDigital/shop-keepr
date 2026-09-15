import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DEFAULT_FX_STEP_THRESHOLD_PCT } from '../../../shared/domain/exchange-rate';
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
	/**
	 * How far, in whole percent, a fetched exchange rate must move from the
	 * one in force before it replaces it (ADR 0003). A number to tune, not a
	 * constant; not surfaced in the MVP UI.
	 */
	fxStepThresholdPct: integer({ mode: 'number' }).notNull().default(DEFAULT_FX_STEP_THRESHOLD_PCT),
	createdAt: epochMs().notNull(),
	updatedAt: epochMs().notNull(),
});
