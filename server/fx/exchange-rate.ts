/**
 * The stepped exchange rate (ADR 0003; spec §6, _FX: the stepped rate_).
 * The shop prices off a rate that is knowingly a little out of date: a
 * fetched rate is a candidate, judged by `judgeStep` against the one in
 * force, and replaces it only past the store's step threshold. A manual
 * set is a step too. Every step is a row in `exchange_rate_step`, the
 * logged event a reprice sweep hangs off. A fetch that fails or returns
 * nothing usable leaves everything as it was and logs loudly.
 *
 * One rate per currency the Mirror prices in, each against the Store's
 * trading currency; the Catalogue's currency is not named anywhere, so it
 * is read from the Printings rather than assumed. The Store's own currency
 * needs no fetch and holds rate 1.
 *
 * Every dependent write carries its own guard in SQL (spec §4.1; ADR
 * 0011): the step lands only while the rate in force is still the one it
 * was judged against, and the rate moves only once its step exists.
 */
import type { ExchangeRateView } from '../../shared/contracts/staff/exchange-rate';
import type { ExchangeRateStepSource } from '../../shared/domain/exchange-rate';
import type { Db } from '../db/client';
import type { RateSource } from './frankfurter';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { exchangeRate, exchangeRateStep, printing, store } from '../db/schema';
import { prepared } from '../ledger/statement';
import { apiError } from '../utils/api-error';
import { newId } from '../utils/ids';
import { STORE_ID } from '../utils/store';
import { judgeStep } from './step';

export interface RefreshOutcome {
	baseCurrency: string;
	quoteCurrency: string;
	/** What the source said, or null when it failed. */
	fetched: number | null;
	/** The rate in force after the refresh. */
	rate: number | null;
	stepped: boolean;
	reason?: 'no_rate' | 'within_threshold';
}

/** The scheduled fetch: every pair the Mirror needs, judged, recorded, stepped where the threshold says. */
export async function refreshExchangeRates(db: Db, { source, now = Date.now() }: { source: RateSource; now?: number }): Promise<RefreshOutcome[]> {
	const { currency: quote, fxStepThresholdPct } = await readFxSettings(db);
	const bases = await db
		.selectDistinct({ currency: printing.marketPriceCurrency })
		.from(printing)
		.where(isNotNull(printing.marketPriceCurrency))
		.orderBy(printing.marketPriceCurrency);
	const outcomes: RefreshOutcome[] = [];
	for (const { currency: base } of bases) {
		if (base === null) {
			continue;
		}
		const held = await readPair(db, base);
		const fetched = await fetchRate(source, base, quote);
		const judgement = judgeStep({ stored: held?.rate ?? null, fetched, thresholdPct: fxStepThresholdPct });
		if (fetched === null || !judgement.step) {
			if (fetched !== null) {
				await recordFetch(db, { base, quote, fetched, now });
			}
			outcomes.push({ baseCurrency: base, quoteCurrency: quote, fetched, rate: held?.rate ?? null, stepped: false, reason: judgement.step ? 'within_threshold' : judgement.reason });
			continue;
		}
		const stepped = await step(db, { base, quote, from: judgement.from, to: judgement.to, fetched, source: 'fetched', sessionId: null, now });
		if (stepped) {
			console.warn(`[fx] ${base}/${quote} stepped ${judgement.from ?? 'nothing'} -> ${judgement.to} (fetched ${fetched}, threshold ${fxStepThresholdPct}%)`);
		}
		outcomes.push({ baseCurrency: base, quoteCurrency: quote, fetched, rate: stepped ? judgement.to : held?.rate ?? null, stepped });
	}
	return outcomes;
}

/** Set manually, from the System page: a step whatever the threshold, recorded with the session that made it. */
export async function setExchangeRateManually(db: Db, { baseCurrency, rate, sessionId, now = Date.now() }: { baseCurrency: string; rate: number; sessionId: string; now?: number }): Promise<ExchangeRateView> {
	const { currency: quote } = await readFxSettings(db);
	const held = await readPair(db, baseCurrency);
	const stepped = await step(db, { base: baseCurrency, quote, from: held?.rate ?? null, to: rate, fetched: null, source: 'manual', sessionId, now });
	if (!stepped) {
		throw apiError('CONFLICT', { message: `The ${baseCurrency}/${quote} rate moved while it was being set; read it again` });
	}
	console.warn(`[fx] ${baseCurrency}/${quote} set manually ${held?.rate ?? 'nothing'} -> ${rate} by session ${sessionId}`);
	const view = (await readExchangeRates(db)).find(v => v.baseCurrency === baseCurrency);
	if (!view) {
		throw apiError('INTERNAL', { message: `The ${baseCurrency}/${quote} rate was set but cannot be read back` });
	}
	return view;
}

/** Every pair the Store holds a rate for, with the step that put it in force, base currency ascending. */
export async function readExchangeRates(db: Db): Promise<ExchangeRateView[]> {
	const rows = await db
		.select({ pair: exchangeRate, step: exchangeRateStep })
		.from(exchangeRate)
		.leftJoin(exchangeRateStep, eq(exchangeRateStep.id, exchangeRate.rateStepId))
		.where(eq(exchangeRate.storeId, STORE_ID))
		.orderBy(exchangeRate.baseCurrency);
	return rows.map(({ pair, step }) => ({
		baseCurrency: pair.baseCurrency,
		quoteCurrency: pair.quoteCurrency,
		rate: pair.rate,
		fetchedRate: pair.fetchedRate,
		fetchedAt: pair.fetchedAt,
		step: step === null
			? null
			: { id: step.id, source: step.source, rateFrom: step.rateFrom, rateTo: step.rateTo, fetchedRate: step.fetchedRate, sessionId: step.sessionId, steppedAt: step.steppedAt },
	}));
}

async function readFxSettings(db: Db): Promise<{ currency: string; fxStepThresholdPct: number }> {
	const row = await db.query.store.findFirst({ columns: { currency: true, fxStepThresholdPct: true }, where: eq(store.id, STORE_ID) });
	if (!row) {
		throw apiError('INTERNAL', { message: 'Store row missing; run the migrations' });
	}
	return row;
}

function readPair(db: Db, base: string) {
	return db.query.exchangeRate.findFirst({ where: and(eq(exchangeRate.storeId, STORE_ID), eq(exchangeRate.baseCurrency, base)) });
}

/** The candidate rate, or null with the failure logged; the Store's own currency is 1 without asking. */
async function fetchRate(source: RateSource, base: string, quote: string): Promise<number | null> {
	if (base === quote) {
		return 1;
	}
	try {
		return (await source.latest(base, quote)).rate;
	}
	catch (error) {
		console.error(`[fx] ${base}/${quote}: the rate could not be fetched; the rate in force stands`, error);
		return null;
	}
}

/** The pair row made to exist with this fetch on it; the rate in force is not touched. */
async function recordFetch(db: Db, { base, quote, fetched, now }: { base: string; quote: string; fetched: number; now: number }): Promise<void> {
	await pairUpsert(db, { base, quote, fetched, now }).run();
}

function pairUpsert(db: Db, { base, quote, fetched, now }: { base: string; quote: string; fetched: number | null; now: number }) {
	return prepared(db, sql`
		INSERT INTO exchange_rate (store_id, base_currency, quote_currency, rate, rate_step_id, fetched_rate, fetched_at, updated_at)
		VALUES (${STORE_ID}, ${base}, ${quote}, NULL, NULL, ${fetched}, ${fetched === null ? null : now}, ${now})
		ON CONFLICT(store_id, base_currency) DO UPDATE SET
			fetched_rate = COALESCE(excluded.fetched_rate, exchange_rate.fetched_rate),
			fetched_at = COALESCE(excluded.fetched_at, exchange_rate.fetched_at),
			updated_at = excluded.updated_at
	`);
}

interface StepInput {
	base: string;
	quote: string;
	from: number | null;
	to: number;
	fetched: number | null;
	source: ExchangeRateStepSource;
	sessionId: string | null;
	now: number;
}

/** One step, atomically: the pair row, its step, the rate moved; false when the rate in force was no longer `from`. */
async function step(db: Db, { base, quote, from, to, fetched, source, sessionId, now }: StepInput): Promise<boolean> {
	const stepId = newId();
	const [, inserted] = await db.$client.batch([
		pairUpsert(db, { base, quote, fetched, now }),
		prepared(db, sql`
			INSERT INTO exchange_rate_step (id, store_id, base_currency, quote_currency, rate_from, rate_to, fetched_rate, source, session_id, stepped_at)
			SELECT ${stepId}, ${STORE_ID}, ${base}, ${quote}, ${from}, ${to}, ${fetched}, ${source}, ${sessionId}, ${now}
			WHERE EXISTS (SELECT 1 FROM exchange_rate WHERE store_id = ${STORE_ID} AND base_currency = ${base} AND rate IS ${from})
		`),
		prepared(db, sql`
			UPDATE exchange_rate SET rate = ${to}, rate_step_id = ${stepId}, quote_currency = ${quote}, updated_at = ${now}
			WHERE store_id = ${STORE_ID} AND base_currency = ${base} AND EXISTS (SELECT 1 FROM exchange_rate_step WHERE id = ${stepId})
		`),
	]);
	return inserted!.meta.changes === 1;
}
