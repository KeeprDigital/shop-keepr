import { describe, expect, it } from 'vitest';
import { apiError } from '../../../server/utils/api-error';

describe('apiError', () => {
	it('carries the code and typed details in h3 error data', () => {
		const error = apiError('INSUFFICIENT_STOCK', { details: { available: 2 } });
		expect(error.statusCode).toBe(409);
		expect(error.data).toEqual({ code: 'INSUFFICIENT_STOCK', details: { available: 2 } });
	});

	it('maps each code to its HTTP status', () => {
		expect(apiError('VALIDATION_FAILED', { details: { issues: [] } }).statusCode).toBe(400);
		expect(apiError('UNAUTHENTICATED').statusCode).toBe(401);
		expect(apiError('FORBIDDEN').statusCode).toBe(403);
		expect(apiError('NOT_FOUND').statusCode).toBe(404);
		expect(apiError('CONFLICT').statusCode).toBe(409);
		expect(apiError('INTERNAL').statusCode).toBe(500);
	});

	it('takes an optional human message', () => {
		expect(apiError('NOT_FOUND', { message: 'No such Basket' }).message).toBe('No such Basket');
	});
});
