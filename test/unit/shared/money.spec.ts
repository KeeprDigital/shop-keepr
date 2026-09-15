import type { Money } from '../../../shared/domain/money';
import { describe, expect, it } from 'vitest';
import { isMoney, money } from '../../../shared/domain/money';

describe('money', () => {
	it('is an integer count of minor units', () => {
		const price: Money = money(1250);
		expect(price).toBe(1250);
		expect(money(0)).toBe(0);
		expect(money(-4500)).toBe(-4500);
	});

	it('refuses anything that is not a safe integer', () => {
		expect(() => money(12.5)).toThrow(/12\.5/);
		expect(() => money(Number.NaN)).toThrow();
		expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow();
	});

	it('recognises integers and nothing else', () => {
		expect(isMoney(99)).toBe(true);
		expect(isMoney(9.9)).toBe(false);
		expect(isMoney('99')).toBe(false);
	});
});
