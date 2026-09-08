/**
 * Issue #25 item 3, stage 2: does Orama actually run inside a Worker?
 *
 * Stage 1 (`size-one.mjs`) measured the index in plain Node: 184 MB of settled heap
 * at 150,000 Printings with stock and Sell Price in the schema, against a Worker's
 * documented 128 MB ceiling. This stage runs the same thing inside real workerd, so
 * the verdict is a measured failure mode rather than an inference from a Node heap
 * figure.
 *
 * Sizes are stepped upward so the point of failure is located, not just asserted.
 */
import { describe, expect, it } from 'vitest';
import { create, insertMultiple, search } from '@orama/orama';
import realNames from '../typo-search/data/all-card-names.json';

const names = realNames as string[];

function docs(n: number, withFilters: boolean) {
	return Array.from({ length: n }, (_, i) => withFilters
		? {
				id: `p-${String(i).padStart(7, '0')}`,
				name: names[i % names.length],
				game: ['magic', 'pokemon', 'onepiece', 'riftbound'][i % 4],
				rarity: ['common', 'uncommon', 'rare', 'mythic'][i % 4],
				sellPrice: (i * 37) % 50_000,
				quantity: i % 7,
			}
		: { id: `p-${String(i).padStart(7, '0')}`, name: names[i % names.length] });
}

describe('Orama inside workerd', () => {
	for (const [n, withFilters] of [
		[38_001, false], [38_001, true], [75_000, true], [100_000, true], [150_000, true],
	] as const) {
		it(`builds ${n} documents ${withFilters ? 'with' : 'without'} stock/price filters`, async () => {
			const schema = withFilters
				? { name: 'string', game: 'enum', rarity: 'enum', sellPrice: 'number', quantity: 'number' }
				: { name: 'string' };
			const t0 = Date.now();
			const db = create({ schema: schema as never });
			await insertMultiple(db, docs(n, withFilters) as never, 5_000);
			const buildMs = Date.now() - t0;

			const t1 = Date.now();
			const r = await search(db, { term: 'Lighming Bolt', threshold: 0, tolerance: 2, limit: 5 } as never);
			const searchMs = Date.now() - t1;

			// eslint-disable-next-line no-console
			console.log(
				`  ${String(n).padStart(7)} docs ${withFilters ? 'w/ filters ' : 'name only  '}`
				+ `build ${String(buildMs).padStart(6)} ms  search ${String(searchMs).padStart(4)} ms  `
				+ `hits ${(r as { count: number }).count}`,
			);
			expect(buildMs).toBeGreaterThan(0);
		}, 900_000);
	}
});
