import type { ErrorCode, ErrorDetailsFor } from '../../shared/contracts/common';
import { createError } from 'h3';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
	VALIDATION_FAILED: 400,
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	INSUFFICIENT_STOCK: 409,
	INTERNAL: 500,
};

/**
 * Builds the h3 error every route throws: status from the code, and
 * `data: { code, details }` per the shared error contract.
 */
export function apiError<C extends ErrorCode>(code: C, details?: ErrorDetailsFor<C>, message?: string) {
	return createError({
		statusCode: STATUS_BY_CODE[code],
		statusMessage: message ?? code,
		message: message ?? code,
		data: details === undefined ? { code } : { code, details },
	});
}
