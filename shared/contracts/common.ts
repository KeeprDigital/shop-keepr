/**
 * The error contract shared by every API route and both UIs (#9): h3
 * `createError({ statusCode, statusMessage, data })` with
 * `data: { code, details? }`. `code` is this closed union; `details` is
 * typed per code. Problem+json was rejected as ceremony for two in-repo
 * consumers.
 */
export const ERROR_CODES = [
	'VALIDATION_FAILED',
	'UNAUTHENTICATED',
	'FORBIDDEN',
	'NOT_FOUND',
	'CONFLICT',
	'INSUFFICIENT_STOCK',
	'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
	return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** `details` shape per code. Codes absent here carry no details. */
export interface ErrorDetails {
	VALIDATION_FAILED: { issues: unknown[] };
	INSUFFICIENT_STOCK: { available: number };
}

export type ErrorDetailsFor<C extends ErrorCode> = C extends keyof ErrorDetails ? ErrorDetails[C] : undefined;

/** The `data` member of an API error response. */
export type ApiErrorData = {
	[C in ErrorCode]: { code: C; details?: ErrorDetailsFor<C> };
}[ErrorCode];
