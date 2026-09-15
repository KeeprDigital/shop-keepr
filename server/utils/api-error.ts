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

interface ApiErrorOptions<C extends ErrorCode> {
	/** Typed per code by the shared contract; codes without details take none. */
	details?: ErrorDetailsFor<C>;
	/** Human-readable message; defaults to the code. */
	message?: string;
}

/**
 * Builds the h3 error every route throws: status from the code, and
 * `data: { code, details }` per the shared error contract.
 */
export function apiError<C extends ErrorCode>(code: C, { details, message = code }: ApiErrorOptions<C> = {}) {
	return createError({
		statusCode: STATUS_BY_CODE[code],
		statusMessage: message,
		message,
		data: details === undefined ? { code } : { code, details },
	});
}
