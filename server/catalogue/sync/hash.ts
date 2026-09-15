/**
 * The content hash `printing_detail`, `catalogue_set` and
 * `catalogue_vocabulary` carry (spec §4.2): SHA-256 over the record in a
 * canonical JSON form, so two pulls of the same record hash the same however
 * the Catalogue orders its keys, and hash match means read, not write
 * (ADR 0009).
 */

export async function contentHash(record: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(record));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		isPlainObject(inner) ? Object.fromEntries(Object.keys(inner).sort().map(k => [k, inner[k]])) : inner);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
