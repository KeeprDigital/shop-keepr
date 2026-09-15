/**
 * The staff search route's query string against the shared contract: the
 * fixed keys by schema, and every `facet.<name>` key as that Facet's
 * values, so the filter controls can pass through whatever the vocabulary
 * lists without the route knowing a Facet name.
 */
import type { SearchQuery } from '../../shared/contracts/staff/search';
import * as z from 'zod';

export const SEARCH_LIMIT_DEFAULT = 50;
export const SEARCH_LIMIT_MAX = 200;

const zFixed = z.object({
	game: z.string().trim().min(1),
	q: z.string().trim().max(200).optional(),
	inStock: z.enum(['true', 'false']).optional(),
	limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
	offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

const zFacetValue = z.string().trim().min(1).max(100);

/** The parsed query, or the Zod issues. */
export function parseSearchQuery(raw: Record<string, unknown>): { ok: true; query: Required<SearchQuery> } | { ok: false; issues: unknown[] } {
	const fixed = zFixed.safeParse(raw);
	if (!fixed.success) {
		return { ok: false, issues: fixed.error.issues };
	}
	const facets: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!key.startsWith('facet.')) {
			continue;
		}
		const values = z.array(zFacetValue).safeParse(Array.isArray(value) ? value : [value]);
		if (!values.success) {
			return { ok: false, issues: values.error.issues };
		}
		facets[key.slice('facet.'.length)] = values.data;
	}
	return {
		ok: true,
		query: {
			game: fixed.data.game,
			q: fixed.data.q ?? '',
			inStock: fixed.data.inStock === 'true',
			limit: fixed.data.limit ?? SEARCH_LIMIT_DEFAULT,
			offset: fixed.data.offset ?? 0,
			facets,
		},
	};
}
