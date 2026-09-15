/**
 * The exchange-rate source (ADR 0003): Frankfurter, which serves the
 * European Central Bank's daily reference rates with no key and no rate
 * limit worth planning around. The Catalogue's price currency and the
 * Store's trading currency are both on its list. The seam is
 * `{ fetch, baseURL }` as the Catalogue client's is, so the cron passes
 * the Worker's `fetch`, a test passes one that answers from memory, and
 * a self-hosted deployment is one URL away.
 *
 * What comes back is a candidate rate: whether it takes effect is
 * `judgeStep`'s call, never this module's.
 */
import { z } from 'zod';

export const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v1';

export interface FetchedRate {
	/** Units of the quote currency per unit of the base. */
	rate: number;
	/** The source's own date for the rate, verbatim. */
	asOf: string;
}

/** Anything that can say what one currency is worth in another today. */
export interface RateSource {
	latest: (base: string, quote: string) => Promise<FetchedRate>;
}

export class ExchangeRateFetchError extends Error {
	constructor(readonly status: number | null, message: string) {
		super(message);
		this.name = 'ExchangeRateFetchError';
	}
}

const zLatest = z.object({
	base: z.string(),
	date: z.string(),
	rates: z.record(z.string(), z.number()),
});

export function createFrankfurterRates({ fetch, baseURL = FRANKFURTER_BASE_URL }: { fetch: typeof globalThis.fetch; baseURL?: string }): RateSource {
	return {
		async latest(base, quote) {
			const url = new URL(`${baseURL.replace(/\/$/, '')}/latest`);
			url.searchParams.set('base', base);
			url.searchParams.set('symbols', quote);
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			if (!response.ok) {
				throw new ExchangeRateFetchError(response.status, `Frankfurter returned ${response.status} for ${base}/${quote}`);
			}
			const parsed = zLatest.safeParse(await response.json());
			if (!parsed.success) {
				throw new ExchangeRateFetchError(response.status, `Frankfurter's answer for ${base}/${quote} is not the expected shape: ${z.prettifyError(parsed.error)}`);
			}
			const rate = parsed.data.rates[quote];
			if (rate === undefined) {
				throw new ExchangeRateFetchError(response.status, `Frankfurter's answer for ${base}/${quote} carries no ${quote} rate`);
			}
			return { rate, asOf: parsed.data.date };
		},
	};
}
