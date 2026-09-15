import { describe, expect, it } from 'vitest';
import { judgeStep } from '../../../server/fx/step';

describe('judging a fetched exchange rate against the one in force (ADR 0003: the rate steps, it does not drift)', () => {
	it('leaves the stored rate untouched when the fetched one is within the threshold', () => {
		expect(judgeStep({ stored: 0.8, fetched: 0.81, thresholdPct: 2 })).toEqual({ step: false, reason: 'within_threshold', movedPct: 1.25 });
	});

	it('steps when the fetched rate has moved past the threshold', () => {
		expect(judgeStep({ stored: 0.8, fetched: 0.82, thresholdPct: 2 })).toEqual({ step: true, from: 0.8, to: 0.82, movedPct: 2.5 });
	});

	it('steps on a move of exactly the threshold, in either direction', () => {
		expect(judgeStep({ stored: 0.8, fetched: 0.784, thresholdPct: 2 })).toMatchObject({ step: true, to: 0.784 });
		expect(judgeStep({ stored: 0.8, fetched: 0.816, thresholdPct: 2 })).toMatchObject({ step: true, to: 0.816 });
	});

	it('takes the first rate a pair ever fetches', () => {
		expect(judgeStep({ stored: null, fetched: 0.8, thresholdPct: 2 })).toEqual({ step: true, from: null, to: 0.8, movedPct: null });
	});

	it('never steps to nothing: a missing or nonsensical fetched rate is no rate', () => {
		expect(judgeStep({ stored: 0.8, fetched: null, thresholdPct: 2 })).toEqual({ step: false, reason: 'no_rate', movedPct: null });
		expect(judgeStep({ stored: 0.8, fetched: 0, thresholdPct: 2 })).toEqual({ step: false, reason: 'no_rate', movedPct: null });
		expect(judgeStep({ stored: 0.8, fetched: Number.NaN, thresholdPct: 2 })).toEqual({ step: false, reason: 'no_rate', movedPct: null });
		expect(judgeStep({ stored: null, fetched: null, thresholdPct: 2 })).toEqual({ step: false, reason: 'no_rate', movedPct: null });
	});

	it('does not step when nothing moved', () => {
		expect(judgeStep({ stored: 0.8, fetched: 0.8, thresholdPct: 2 })).toEqual({ step: false, reason: 'within_threshold', movedPct: 0 });
	});
});
