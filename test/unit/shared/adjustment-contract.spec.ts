import { describe, expect, it } from 'vitest';
import { zAdjustmentRequest } from '../../../shared/contracts/staff/adjustment';

const base = { printingId: 'prt-1', condition: 'NM', language: 'en' } as const;

describe('the Adjust modal request (spec §8.2, _Adjust modal_)', () => {
	it('accepts a delta with a Reason', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: -2 }, reason: 'damage' }).success).toBe(true);
	});

	it('accepts a new count of zero', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, change: { newCount: 0 }, reason: 'miscount' }).success).toBe(true);
	});

	it('rejects a delta of nothing', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 0 }, reason: 'miscount' }).success).toBe(false);
	});

	it('does not offer initial-load: that is the Ingest session Reason', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 1 }, reason: 'initial-load' }).success).toBe(false);
	});

	it('ties a regrade to Reason condition-regrade and a different target Condition', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 1 }, regradeTo: 'LP', reason: 'condition-regrade' }).success).toBe(true);
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 1 }, regradeTo: 'LP', reason: 'miscount' }).success).toBe(false);
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 1 }, reason: 'condition-regrade' }).success).toBe(false);
		expect(zAdjustmentRequest.safeParse({ ...base, change: { delta: 1 }, regradeTo: 'NM', reason: 'condition-regrade' }).success).toBe(false);
		expect(zAdjustmentRequest.safeParse({ ...base, change: { newCount: 1 }, regradeTo: 'LP', reason: 'condition-regrade' }).success).toBe(false);
	});

	it('leaves Language to the write boundary: blank or any spelling passes here', () => {
		expect(zAdjustmentRequest.safeParse({ ...base, language: undefined, change: { delta: 1 }, reason: 'found' }).success).toBe(true);
		expect(zAdjustmentRequest.safeParse({ ...base, language: 'JA', change: { delta: 1 }, reason: 'found' }).success).toBe(true);
	});
});
