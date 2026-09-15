/**
 * Bulk-write plumbing for the measured D1 caps (spec §4.1, _Measured
 * limits_): 100 bound parameters per statement, so bulk writes inline
 * escaped literals; 100,000 bytes per statement, so rows are packed to a
 * budget under it.
 */

/** Pack to ~90 KB; the cap is exactly 100,000 bytes (spec §4.1). */
export const STATEMENT_BYTES = 90_000;

export type Literal = string | number | boolean | null;

/** One value as a SQL literal. Text is quoted with `'` doubled; SQLite has no other escape. */
export function literal(value: Literal): string {
	switch (typeof value) {
		case 'string':
			return `'${value.replaceAll(`'`, `''`)}'`;
		case 'number':
			if (!Number.isSafeInteger(value)) {
				throw new RangeError(`Only safe integers are inlined, got ${value}`);
			}
			return String(value);
		case 'boolean':
			return value ? '1' : '0';
		default:
			return 'NULL';
	}
}

/** A `(a, b, c)` row tuple of literals. */
export function tuple(values: Literal[]): string {
	return `(${values.map(literal).join(',')})`;
}

/**
 * `head` + rows joined by `,` + `tail`, split into as many statements as the
 * byte budget needs. Rows keep their order; every row lands exactly once.
 * A row that alone exceeds the budget is emitted on its own and left to D1
 * to refuse, loudly, rather than silently dropped.
 */
export function packRows(head: string, rows: string[], tail: string, budget = STATEMENT_BYTES): string[] {
	const fixed = utf8Bytes(head) + utf8Bytes(tail);
	const statements: string[] = [];
	let batch: string[] = [];
	let used = fixed;
	for (const row of rows) {
		const cost = utf8Bytes(row) + (batch.length > 0 ? 1 : 0);
		if (batch.length > 0 && used + cost > budget) {
			statements.push(head + batch.join(',') + tail);
			batch = [];
			used = fixed;
		}
		batch.push(row);
		used += utf8Bytes(row) + (batch.length > 1 ? 1 : 0);
	}
	if (batch.length > 0) {
		statements.push(head + batch.join(',') + tail);
	}
	return statements;
}

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}
