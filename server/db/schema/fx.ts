import type { ExchangeRateStepSource } from '../../../shared/domain/exchange-rate';
import { index, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { EXCHANGE_RATE_STEP_SOURCES } from '../../../shared/domain/exchange-rate';
import { epochMs, storeId, ulid } from '../columns';
import { store } from './store';

/**
 * The log every step writes: a rate change is a deliberate, recorded
 * event that a reprice sweep hangs off and that someone can point at when
 * asked why a price moved. Never edited.
 */
export const exchangeRateStep = sqliteTable('exchange_rate_step', {
	id: ulid().primaryKey(),
	storeId: storeId().references(() => store.id),
	baseCurrency: text().notNull(),
	quoteCurrency: text().notNull(),
	/** Null for the first rate a pair ever had. */
	rateFrom: real(),
	rateTo: real().notNull(),
	/** The fetched rate the step judged, null for a manual set. */
	fetchedRate: real(),
	source: text({ enum: EXCHANGE_RATE_STEP_SOURCES }).$type<ExchangeRateStepSource>().notNull(),
	/** The staff session that set the rate by hand; null for a fetched step. */
	sessionId: text(),
	steppedAt: epochMs().notNull(),
}, table => [
	index('exchange_rate_step_store_stepped').on(table.storeId, table.steppedAt),
]);

/**
 * The stepped exchange rate (ADR 0003; spec §6, _FX: the stepped rate_).
 * One row per (Store, Catalogue currency): the rate in force, which the
 * pricing pipeline converts a Market Price at, and the rate last fetched,
 * which is only ever a candidate. The two differ on purpose between steps;
 * anyone reading this beside a live rate should not "fix" it.
 *
 * A rate is a ratio, not Money, so it is the one REAL column in the
 * schema: `quote = round(base x rate)` in the pipeline's first step.
 */
export const exchangeRate = sqliteTable('exchange_rate', {
	storeId: storeId().references(() => store.id),
	/** The currency the Catalogue states Market Prices in, as `printing.market_price_currency` carries it. */
	baseCurrency: text().notNull(),
	/** The Store's trading currency at the time of the last step. */
	quoteCurrency: text().notNull(),
	/** The rate in force; null until the first fetch or manual set. */
	rate: real(),
	/** The step that put `rate` in force. */
	rateStepId: text().references(() => exchangeRateStep.id),
	/** What the last successful fetch returned, whether or not it stepped. */
	fetchedRate: real(),
	fetchedAt: epochMs(),
	updatedAt: epochMs().notNull(),
}, table => [
	primaryKey({ columns: [table.storeId, table.baseCurrency] }),
]);
