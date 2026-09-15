/**
 * The stepped exchange rate (ADR 0003; spec §6, _FX: the stepped rate_):
 * the rate a Market Price is converted at is held as a discrete, versioned
 * value. It moves only by a **step**, which is a logged event, and a step
 * comes from one of two places. Defined once here so the schema, the FX
 * module and the System page share the one list.
 */
import { isOneOf } from './one-of';

/**
 * `fetched`: the scheduled fetch found the rate moved past the store's
 * step threshold. `manual`: a person set it on the System page.
 */
export const EXCHANGE_RATE_STEP_SOURCES = ['fetched', 'manual'] as const;

export type ExchangeRateStepSource = (typeof EXCHANGE_RATE_STEP_SOURCES)[number];

export function isExchangeRateStepSource(value: unknown): value is ExchangeRateStepSource {
	return isOneOf(EXCHANGE_RATE_STEP_SOURCES, value);
}

/** The step threshold every Store starts with, in whole percent (spec §6, _Store settings_). */
export const DEFAULT_FX_STEP_THRESHOLD_PCT = 2;
