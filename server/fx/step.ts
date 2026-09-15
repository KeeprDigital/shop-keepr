/**
 * The one rule of the stepped exchange rate (ADR 0003; spec §6, _FX: the
 * stepped rate_): a fetched rate replaces the one in force only when it
 * has moved past the store's step threshold; a move of exactly the
 * threshold is not past it. Between
 * steps the rate does not move at all. Pure, so the threshold arithmetic
 * is tested on its own and the service only records what this decides.
 */

export interface StepInput {
	/** The rate in force; null before the pair's first step. */
	stored: number | null;
	/** What the fetch returned; null when it failed or returned nothing usable. */
	fetched: number | null;
	/** Whole percent, the store setting. */
	thresholdPct: number;
}

export type StepJudgement
	= | { step: true; from: number | null; to: number; movedPct: number | null }
		| { step: false; reason: 'no_rate' | 'within_threshold'; movedPct: number | null };

export function judgeStep({ stored, fetched, thresholdPct }: StepInput): StepJudgement {
	if (fetched === null || !Number.isFinite(fetched) || fetched <= 0) {
		return { step: false, reason: 'no_rate', movedPct: null };
	}
	if (stored === null) {
		return { step: true, from: null, to: fetched, movedPct: null };
	}
	// Rounded to a millionth of a percent, far below any rate's precision, so float noise cannot decide a step.
	const movedPct = Math.round((Math.abs(fetched - stored) / stored) * 100 * 1e6) / 1e6;
	if (movedPct <= thresholdPct) {
		return { step: false, reason: 'within_threshold', movedPct };
	}
	return { step: true, from: stored, to: fetched, movedPct };
}
