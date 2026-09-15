import type { RateSource } from '../../server/fx/frankfurter';
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../../server/db/client';
import { exchangeRateStep } from '../../server/db/schema';
import { readExchangeRates, refreshExchangeRates, setExchangeRateManually } from '../../server/fx/exchange-rate';
import { seedPrinting } from '../support/stock';

const db = createDb(env.DB);

/** A source that answers every pair with one rate, or refuses. */
function sourceOf(answer: number | Error, asked: string[] = []): RateSource {
	return {
		latest: async (base, quote) => {
			asked.push(`${base}/${quote}`);
			if (answer instanceof Error) {
				throw answer;
			}
			return { rate: answer, asOf: '2026-09-11' };
		},
	};
}

let tick = 1_900_000_000_000;
const refresh = (answer: number | Error, asked?: string[]) => refreshExchangeRates(db, { source: sourceOf(answer, asked), now: (tick += 60_000) });
const steps = () => db.select().from(exchangeRateStep).orderBy(exchangeRateStep.steppedAt);

describe('the stepped exchange rate (ADR 0003: fetched on a schedule, held as a discrete versioned value)', () => {
	beforeEach(async () => {
		// The Store trades in GBP (the seed migration); the Catalogue prices this Printing in USD.
		await seedPrinting(db, { marketPrice: 240, marketPriceCurrency: 'USD', marketPriceCursor: 'pokemon-price-0001', marketPriceUpdatedAt: 1_789_084_800_000 });
	});

	it('puts the first fetched rate in force and records it as a step', async () => {
		const asked: string[] = [];
		const outcome = await refresh(0.79, asked);
		expect(asked).toEqual(['USD/GBP']);
		expect(outcome).toEqual([{ baseCurrency: 'USD', quoteCurrency: 'GBP', fetched: 0.79, rate: 0.79, stepped: true }]);

		const [view] = await readExchangeRates(db);
		expect(view).toMatchObject({ baseCurrency: 'USD', quoteCurrency: 'GBP', rate: 0.79, fetchedRate: 0.79, fetchedAt: tick });
		expect(view!.step).toMatchObject({ source: 'fetched', rateFrom: null, rateTo: 0.79, fetchedRate: 0.79, sessionId: null, steppedAt: tick });
	});

	it('records a fetch within the threshold and leaves the rate in force untouched', async () => {
		await refresh(0.79);
		const outcome = await refresh(0.795);
		expect(outcome).toEqual([{ baseCurrency: 'USD', quoteCurrency: 'GBP', fetched: 0.795, rate: 0.79, stepped: false, reason: 'within_threshold' }]);

		const [view] = await readExchangeRates(db);
		expect(view).toMatchObject({ rate: 0.79, fetchedRate: 0.795, fetchedAt: tick });
		expect(view!.step).toMatchObject({ rateTo: 0.79 });
		expect(await steps()).toHaveLength(1);
	});

	it('replaces the rate when a fetch moves past the threshold, and records the step', async () => {
		await refresh(0.79);
		const info = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const outcome = await refresh(0.81);
			expect(outcome).toEqual([{ baseCurrency: 'USD', quoteCurrency: 'GBP', fetched: 0.81, rate: 0.81, stepped: true }]);
			expect(info).toHaveBeenCalledWith(expect.stringMatching(/USD\/GBP.*0\.79.*0\.81/));
		}
		finally {
			info.mockRestore();
		}
		const [view] = await readExchangeRates(db);
		expect(view).toMatchObject({ rate: 0.81, fetchedRate: 0.81 });
		expect(view!.step).toMatchObject({ source: 'fetched', rateFrom: 0.79, rateTo: 0.81, fetchedRate: 0.81, steppedAt: tick });
		expect((await steps()).map(s => s.rateTo)).toEqual([0.79, 0.81]);
	});

	it('keeps the rate in force and the last good fetch when the source fails, and logs loudly', async () => {
		await refresh(0.79);
		const before = await readExchangeRates(db);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const outcome = await refresh(new Error('upstream is down'));
			expect(outcome).toEqual([{ baseCurrency: 'USD', quoteCurrency: 'GBP', fetched: null, rate: 0.79, stepped: false, reason: 'no_rate' }]);
			expect(error).toHaveBeenCalledWith(expect.stringMatching(/USD\/GBP/), expect.any(Error));
		}
		finally {
			error.mockRestore();
		}
		expect(await readExchangeRates(db)).toEqual(before);
	});

	it('takes a manual set as a step of its own, recorded with who set it, and judges the next fetch against it', async () => {
		await refresh(0.79);
		const view = await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.85, sessionId: 'sess_counter_1', now: (tick += 60_000) });
		expect(view).toMatchObject({ baseCurrency: 'USD', quoteCurrency: 'GBP', rate: 0.85, fetchedRate: 0.79 });
		expect(view.step).toMatchObject({ source: 'manual', rateFrom: 0.79, rateTo: 0.85, fetchedRate: null, sessionId: 'sess_counter_1', steppedAt: tick });

		const outcome = await refresh(0.84);
		expect(outcome[0]).toMatchObject({ rate: 0.85, stepped: false, reason: 'within_threshold' });
		expect((await steps()).map(s => [s.source, s.rateTo])).toEqual([['fetched', 0.79], ['manual', 0.85]]);
	});

	it('can be set by hand before anything was ever fetched', async () => {
		const view = await setExchangeRateManually(db, { baseCurrency: 'USD', rate: 0.8, sessionId: 'sess_counter_1', now: tick });
		expect(view).toMatchObject({ rate: 0.8, fetchedRate: null, fetchedAt: null });
		expect(view.step).toMatchObject({ source: 'manual', rateFrom: null, rateTo: 0.8 });
	});

	it('fetches one rate per currency the Mirror prices in, and none for the Store\'s own', async () => {
		await seedPrinting(db, { id: 'prt-pokemon-base1-4', marketPrice: 41000, marketPriceCurrency: 'GBP' });
		await seedPrinting(db, { id: 'prt-pokemon-base1-88', marketPrice: 180, marketPriceCurrency: 'USD' });
		const asked: string[] = [];
		const outcome = await refresh(0.79, asked);
		expect(asked).toEqual(['USD/GBP']);
		expect(outcome).toEqual(expect.arrayContaining([
			{ baseCurrency: 'GBP', quoteCurrency: 'GBP', fetched: 1, rate: 1, stepped: true },
			{ baseCurrency: 'USD', quoteCurrency: 'GBP', fetched: 0.79, rate: 0.79, stepped: true },
		]));
		expect((await readExchangeRates(db)).map(v => v.baseCurrency)).toEqual(['GBP', 'USD']);
	});

	it('fetches nothing when the Mirror prices nothing', async () => {
		await env.DB.prepare('DELETE FROM printing').run();
		const asked: string[] = [];
		expect(await refresh(0.79, asked)).toEqual([]);
		expect(asked).toEqual([]);
		expect(await readExchangeRates(db)).toEqual([]);
	});
});
