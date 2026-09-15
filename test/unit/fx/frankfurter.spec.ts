import { describe, expect, it } from 'vitest';
import { createFrankfurterRates, ExchangeRateFetchError } from '../../../server/fx/frankfurter';

/** A `fetch` that answers one URL with one body, and records what was asked. */
function fetchAnswering(status: number, body: unknown, asked: string[] = []): typeof fetch {
	return async (input, init) => {
		asked.push(new Request(input, init).url);
		return Response.json(body, { status });
	};
}

describe('the Frankfurter rate source (ADR 0003: a fetched rate is only ever a candidate)', () => {
	it('asks for the latest rate of one pair and returns it with its date', async () => {
		const asked: string[] = [];
		const rates = createFrankfurterRates({ fetch: fetchAnswering(200, { amount: 1, base: 'USD', date: '2026-09-11', rates: { GBP: 0.7891 } }, asked) });
		expect(await rates.latest('USD', 'GBP')).toEqual({ rate: 0.7891, asOf: '2026-09-11' });
		expect(asked).toEqual(['https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP']);
	});

	it('takes a base URL for another deployment of the same API', async () => {
		const asked: string[] = [];
		const rates = createFrankfurterRates({ fetch: fetchAnswering(200, { amount: 1, base: 'USD', date: '2026-09-11', rates: { AUD: 1.51 } }, asked), baseURL: 'http://frankfurter.local:8080' });
		expect(await rates.latest('USD', 'AUD')).toEqual({ rate: 1.51, asOf: '2026-09-11' });
		expect(asked).toEqual(['http://frankfurter.local:8080/latest?base=USD&symbols=AUD']);
	});

	it('fails loudly on a refused request', async () => {
		const rates = createFrankfurterRates({ fetch: fetchAnswering(404, { message: 'not found' }) });
		await expect(rates.latest('USD', 'XXX')).rejects.toThrow(ExchangeRateFetchError);
		await expect(rates.latest('USD', 'XXX')).rejects.toThrow(/404/);
	});

	it('fails loudly when the answer does not carry the pair asked for', async () => {
		const rates = createFrankfurterRates({ fetch: fetchAnswering(200, { amount: 1, base: 'USD', date: '2026-09-11', rates: { EUR: 0.9 } }) });
		await expect(rates.latest('USD', 'GBP')).rejects.toThrow(/GBP/);
	});
});
