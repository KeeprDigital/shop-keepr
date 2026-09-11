import { describe, expect, it } from 'vitest';
import { compareCondition, CONDITIONS, isCondition } from '../../../shared/domain/condition';

describe('condition', () => {
	it('is the fixed five-grade scale in sort order', () => {
		expect(CONDITIONS).toEqual(['NM', 'LP', 'MP', 'HP', 'DMG']);
	});

	it('sorts better grades first', () => {
		expect((['DMG', 'NM', 'HP', 'LP', 'MP'] as const).toSorted(compareCondition)).toEqual(['NM', 'LP', 'MP', 'HP', 'DMG']);
	});

	it('recognises only the codes on the scale', () => {
		expect(isCondition('NM')).toBe(true);
		expect(isCondition('nm')).toBe(false);
		expect(isCondition('Near Mint')).toBe(false);
	});
});
