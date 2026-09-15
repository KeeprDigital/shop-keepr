/**
 * The stepped exchange rate as the System page reads and sets it (spec
 * §8.2, _System_: stepped rate in force, last fetched rate, fetched at,
 * **Set manually**; ADR 0003). One view per currency the Catalogue prices
 * in; the quote is always the Store's trading currency.
 */
import type { ExchangeRateStepSource } from '../../domain/exchange-rate';
import * as z from 'zod';

export const zExchangeRateSetRequest = z.object({
	/** ISO 4217, as `printing.market_price_currency` carries it. */
	baseCurrency: z.string().trim().toUpperCase().length(3),
	/** Units of the Store's currency per unit of the base. */
	rate: z.number().positive().finite(),
});

export type ExchangeRateSetRequest = z.output<typeof zExchangeRateSetRequest>;

/** One logged step: why the rate in force is what it is. */
export interface ExchangeRateStepView {
	id: string;
	source: ExchangeRateStepSource;
	rateFrom: number | null;
	rateTo: number;
	/** The fetched rate that was judged; null for a manual set. */
	fetchedRate: number | null;
	/** The staff session that set it by hand; null for a fetched step. */
	sessionId: string | null;
	steppedAt: number;
}

export interface ExchangeRateView {
	baseCurrency: string;
	quoteCurrency: string;
	/** The rate in force; null until the first step. */
	rate: number | null;
	/** What the last successful fetch returned, stepped or not. */
	fetchedRate: number | null;
	fetchedAt: number | null;
	/** The step that put `rate` in force. */
	step: ExchangeRateStepView | null;
}
