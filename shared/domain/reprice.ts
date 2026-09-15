/**
 * The reprice sweep's closed lists (spec §6, _The sweep_): why a sweep was
 * asked for, and where it is. Defined once so the schema, the sweep and
 * the System page share them.
 */
import { isOneOf } from './one-of';

/** `settings`: a Pricing Rule changed. `fx`: the exchange rate stepped. `market_price`: a Market Price run moved prices. `manual`: asked for from the System page. */
export const REPRICE_REASONS = ['settings', 'fx', 'market_price', 'manual'] as const;

export type RepriceReason = (typeof REPRICE_REASONS)[number];

export const REPRICE_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

export type RepriceStatus = (typeof REPRICE_STATUSES)[number];

export function isRepriceStatus(value: unknown): value is RepriceStatus {
	return isOneOf(REPRICE_STATUSES, value);
}

/** `rule`: the Pricing Rules set it. `pinned`: a person fixed it by hand, and every recompute leaves it alone. */
export const PRICE_SOURCES = ['rule', 'pinned'] as const;

export type PriceSource = (typeof PRICE_SOURCES)[number];
