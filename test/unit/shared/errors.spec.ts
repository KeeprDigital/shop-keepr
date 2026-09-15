import { describe, expect, it } from 'vitest';
import { ERROR_CODES, isErrorCode } from '../../../shared/contracts/common';

describe('error codes', () => {
	it('is a closed list', () => {
		expect(ERROR_CODES).toEqual([
			'VALIDATION_FAILED',
			'UNAUTHENTICATED',
			'FORBIDDEN',
			'NOT_FOUND',
			'CONFLICT',
			'INSUFFICIENT_STOCK',
			'INTERNAL',
		]);
	});

	it('recognises only codes on the list', () => {
		expect(isErrorCode('NOT_FOUND')).toBe(true);
		expect(isErrorCode('not_found')).toBe(false);
	});
});
