/**
 * What every evaluation needs beside the query (spec §6, _Inputs_): the
 * Pricing Rules, the Store's currency and the stepped exchange rate for
 * each currency the Catalogue prices in (ADR 0003). Read once per request
 * or per sweep chunk, never per SKU.
 */
import type { PricingSettings } from '../../shared/pricing/settings';
import type { Db } from '../db/client';
import { and, eq, isNotNull } from 'drizzle-orm';
import { exchangeRate } from '../db/schema';
import { readStoreSettings } from '../services/store';
import { STORE_ID } from '../utils/store';
import { readPricingSettings } from './settings';

export interface PricingContext {
	settings: PricingSettings;
	/** The Store's trading currency, ISO 4217. */
	currency: string;
	/** Catalogue currency → the rate in force; the Store's own currency needs none. */
	fxRates: ReadonlyMap<string, number>;
}

export async function loadPricingContext(db: Db): Promise<PricingContext> {
	const [settings, { currency }, rates] = await Promise.all([
		readPricingSettings(db),
		readStoreSettings(db),
		db.select({ baseCurrency: exchangeRate.baseCurrency, rate: exchangeRate.rate }).from(exchangeRate).where(and(eq(exchangeRate.storeId, STORE_ID), isNotNull(exchangeRate.rate))),
	]);
	return { settings, currency, fxRates: new Map(rates.map(r => [r.baseCurrency, r.rate!])) };
}

/** The rate a Market Price in `currency` converts at, or null when no step has put one in force yet. */
export function fxRateFor(ctx: PricingContext, currency: string | null): number | null {
	if (currency === null) {
		return null;
	}
	if (currency === ctx.currency) {
		return 1;
	}
	return ctx.fxRates.get(currency) ?? null;
}
