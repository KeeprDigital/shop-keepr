import type { H3Event } from 'h3';
import type * as z from 'zod';
import { getQuery, readBody } from 'h3';

/** The request body against its shared Zod schema; a miss is the contract's `VALIDATION_FAILED` with the issues. */
export async function validateBody<S extends z.ZodType>(event: H3Event, schema: S): Promise<z.output<S>> {
	return parseOrThrow(schema, await readBody(event));
}

/** The query string against its schema, the same way. */
export function validateQuery<S extends z.ZodType>(event: H3Event, schema: S): z.output<S> {
	return parseOrThrow(schema, getQuery(event));
}

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw apiError('VALIDATION_FAILED', { details: { issues: result.error.issues } });
	}
	return result.data;
}
