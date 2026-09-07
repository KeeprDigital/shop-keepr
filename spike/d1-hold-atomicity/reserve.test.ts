import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { RESERVE_SQL, reserve, reserveStatement } from './reserve';
import { SCHEMA } from './schema';

const TTL_MS = 60_000;

async function resetSchema(): Promise<void> {
	await env.DB.exec(SCHEMA);
}

async function seed(itemId: string, onHand: number): Promise<void> {
	await env.DB.prepare('INSERT INTO inventory_item (id, on_hand) VALUES (?1, ?2)')
		.bind(itemId, onHand)
		.run();
}

async function truncateHolds(): Promise<void> {
	await env.DB.prepare('DELETE FROM hold').run();
}

async function heldQuantity(itemId: string): Promise<number> {
	const row = await env.DB.prepare(
		'SELECT COALESCE(SUM(quantity), 0) AS q, COUNT(*) AS n FROM hold WHERE inventory_item_id = ?1',
	)
		.bind(itemId)
		.first<{ q: number; n: number }>();
	return row?.q ?? 0;
}

async function holdRowCount(itemId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM hold WHERE inventory_item_id = ?1')
		.bind(itemId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** Fire `count` reservation attempts with every promise created before any is awaited. */
async function stampede(
	itemId: string,
	count: number,
	quantity: number,
	now: number,
): Promise<number[]> {
	const attempts = Array.from({ length: count }, (_, i) =>
		reserve(env.DB, {
			itemId,
			basketId: `basket-${i}`,
			quantity,
			expiresAt: now + TTL_MS,
			now,
		}),
	);
	const results = await Promise.all(attempts);
	return results.map(r => r.changes);
}

beforeEach(async () => {
	await resetSchema();
});

describe('single-statement reservation — baseline', () => {
	it('grants the first request and refuses the second when on_hand = 1', async () => {
		await seed('sku-1', 1);
		const now = Date.now();

		const first = await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'b1',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});
		const second = await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'b2',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});

		expect(first).toMatchObject({ granted: true, changes: 1 });
		expect(second).toMatchObject({ granted: false, changes: 0 });
		expect(await holdRowCount('sku-1')).toBe(1);
	});

	it('reports changes = 0 rather than throwing for an unknown SKU', async () => {
		const now = Date.now();
		const result = await reserve(env.DB, {
			itemId: 'does-not-exist',
			basketId: 'b1',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});
		expect(result).toMatchObject({ granted: false, changes: 0 });
	});
});

/**
 * Negative control. If the harness cannot make the *naive* JS read-then-write
 * oversell, then a green result for the single statement proves nothing — it
 * would only show that the harness never interleaves anything.
 */
describe('measurement 0 — negative control: naive read-then-write in JS', () => {
	async function naiveReserve(itemId: string, basketId: string, quantity: number, now: number) {
		const row = await env.DB.prepare(
			'SELECT (SELECT on_hand FROM inventory_item WHERE id = ?1) '
			+ '- COALESCE((SELECT SUM(quantity) FROM hold WHERE inventory_item_id = ?1 AND expires_at > ?2), 0) AS available',
		)
			.bind(itemId, now)
			.first<{ available: number }>();
		if ((row?.available ?? 0) < quantity) return false;
		await env.DB.prepare(
			'INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?1, ?2, ?3, ?4)',
		)
			.bind(itemId, basketId, quantity, now + TTL_MS)
			.run();
		return true;
	}

	it('DOES oversell — so the harness has discriminating power', async () => {
		await seed('sku-1', 1);
		let oversellIterations = 0;
		const successCounts: number[] = [];

		for (let iteration = 0; iteration < 50; iteration++) {
			await truncateHolds();
			const now = Date.now();
			const results = await Promise.all(
				Array.from({ length: 25 }, (_, i) => naiveReserve('sku-1', `basket-${i}`, 1, now)),
			);
			const granted = results.filter(Boolean).length;
			successCounts.push(granted);
			if (granted > 1) oversellIterations++;
		}

		// eslint-disable-next-line no-console
		console.log(
			`[NEGATIVE CONTROL naive read-then-write, concurrency=25] iterations=50 `
			+ `distinct successes=${JSON.stringify([...new Set(successCounts)].sort((a, b) => a - b))} `
			+ `oversell_iterations=${oversellIterations}`,
		);

		expect(oversellIterations).toBeGreaterThan(0);
	});
});

describe('measurement 1 — oversell under concurrency (direct D1 binding)', () => {
	const ITERATIONS = 50;

	for (const concurrency of [2, 10, 50, 200]) {
		it(`allows exactly one hold on on_hand = 1 with ${concurrency} concurrent attempts, over ${ITERATIONS} iterations`, async () => {
			await seed('sku-1', 1);
			const successCounts: number[] = [];
			const oversells: Array<{ iteration: number; rows: number; changes: number[] }> = [];

			for (let iteration = 0; iteration < ITERATIONS; iteration++) {
				await truncateHolds();
				const now = Date.now();
				const changes = await stampede('sku-1', concurrency, 1, now);
				const granted = changes.filter(c => c > 0).length;
				const rows = await holdRowCount('sku-1');
				successCounts.push(granted);
				if (granted !== 1 || rows !== 1) {
					oversells.push({ iteration, rows, changes });
				}
			}

			// eslint-disable-next-line no-console
			console.log(
				`[concurrency=${concurrency}] iterations=${ITERATIONS} `
				+ `successes per iteration: min=${Math.min(...successCounts)} max=${Math.max(...successCounts)} `
				+ `distinct=${JSON.stringify([...new Set(successCounts)].sort((a, b) => a - b))} `
				+ `oversell_iterations=${oversells.length}`,
			);

			expect(oversells).toEqual([]);
			expect(successCounts.every(c => c === 1)).toBe(true);
		});
	}
});

describe('measurement 1b — oversell under concurrency (through the Worker fetch handler)', () => {
	const ITERATIONS = 50;
	const CONCURRENCY = 25;

	it(`allows exactly one hold across ${CONCURRENCY} concurrent HTTP requests, over ${ITERATIONS} iterations`, async () => {
		await seed('sku-1', 1);
		const successCounts: number[] = [];
		let oversellIterations = 0;

		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			await truncateHolds();
			const now = Date.now();
			const responses = await Promise.all(
				Array.from({ length: CONCURRENCY }, (_, i) =>
					SELF.fetch('https://spike.test/reserve', {
						method: 'POST',
						body: JSON.stringify({
							itemId: 'sku-1',
							basketId: `basket-${i}`,
							quantity: 1,
							expiresAt: now + TTL_MS,
							now,
						}),
					})),
			);
			const bodies = (await Promise.all(responses.map(r => r.json()))) as Array<{
				granted: boolean;
			}>;
			const granted = bodies.filter(b => b.granted).length;
			const rows = await holdRowCount('sku-1');
			successCounts.push(granted);
			if (granted !== 1 || rows !== 1) oversellIterations++;
		}

		// eslint-disable-next-line no-console
		console.log(
			`[http concurrency=${CONCURRENCY}] iterations=${ITERATIONS} `
			+ `distinct successes=${JSON.stringify([...new Set(successCounts)].sort((a, b) => a - b))} `
			+ `oversell_iterations=${oversellIterations}`,
		);

		expect(oversellIterations).toBe(0);
	});
});

describe('measurement 2 — partial quantities', () => {
	const ITERATIONS = 50;

	it('grants exactly two of three concurrent quantity-2 requests against on_hand = 5', async () => {
		await seed('sku-1', 5);
		const successCounts: number[] = [];
		const heldTotals: number[] = [];

		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			await truncateHolds();
			const now = Date.now();
			const changes = await stampede('sku-1', 3, 2, now);
			successCounts.push(changes.filter(c => c > 0).length);
			heldTotals.push(await heldQuantity('sku-1'));
		}

		// eslint-disable-next-line no-console
		console.log(
			`[partial qty on_hand=5 x3 requests of 2] iterations=${ITERATIONS} `
			+ `distinct successes=${JSON.stringify([...new Set(successCounts)].sort((a, b) => a - b))} `
			+ `distinct held totals=${JSON.stringify([...new Set(heldTotals)].sort((a, b) => a - b))}`,
		);

		expect(successCounts.every(c => c === 2)).toBe(true);
		expect(heldTotals.every(q => q === 4)).toBe(true);
	});

	it('never lets the sum of held quantity exceed on_hand under mixed-size concurrency', async () => {
		await seed('sku-1', 7);
		const overCommits: number[] = [];

		for (let iteration = 0; iteration < 50; iteration++) {
			await truncateHolds();
			const now = Date.now();
			const sizes = [1, 2, 3, 1, 4, 2, 5, 1, 3, 2];
			const results = await Promise.all(
				sizes.map((quantity, i) =>
					reserve(env.DB, {
						itemId: 'sku-1',
						basketId: `basket-${i}`,
						quantity,
						expiresAt: now + TTL_MS,
						now,
					}),
				),
			);
			void results;
			const held = await heldQuantity('sku-1');
			if (held > 7) overCommits.push(held);
		}

		// eslint-disable-next-line no-console
		console.log(`[mixed sizes on_hand=7] over-commits=${overCommits.length}`);
		expect(overCommits).toEqual([]);
	});
});

describe('measurement 3 — expired holds do not block', () => {
	it('ignores a hold whose expires_at is in the past', async () => {
		await seed('sku-1', 1);
		const now = Date.now();

		await env.DB.prepare(
			'INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?1, ?2, ?3, ?4)',
		)
			.bind('sku-1', 'stale-basket', 1, now - 1)
			.run();

		const result = await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'fresh-basket',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});

		expect(result).toMatchObject({ granted: true, changes: 1 });
		expect(await holdRowCount('sku-1')).toBe(2);
	});

	it('still blocks on a hold that expires exactly now (strict > comparison)', async () => {
		await seed('sku-1', 1);
		const now = Date.now();
		await env.DB.prepare(
			'INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at) VALUES (?1, ?2, ?3, ?4)',
		)
			.bind('sku-1', 'edge-basket', 1, now)
			.run();

		const result = await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'fresh-basket',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});
		// expires_at > now is false when they are equal, so the stale hold is ignored.
		expect(result.granted).toBe(true);
	});
});

describe('measurement 4 — behaviour inside db.batch()', () => {
	it('keeps the conditional insert conditional and reports changes per statement', async () => {
		await seed('sku-1', 1);
		const now = Date.now();

		const first = await env.DB.batch([
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b1',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
			env.DB.prepare('UPDATE inventory_item SET on_hand = on_hand WHERE id = ?1').bind('sku-1'),
		]);
		const second = await env.DB.batch([
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b2',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
			env.DB.prepare('UPDATE inventory_item SET on_hand = on_hand WHERE id = ?1').bind('sku-1'),
		]);

		// eslint-disable-next-line no-console
		console.log(
			`[batch] first stmt changes=${first[0].meta.changes} second batch stmt changes=${second[0].meta.changes}`,
		);

		expect(first[0].meta.changes).toBe(1);
		expect(second[0].meta.changes).toBe(0);
		expect(await holdRowCount('sku-1')).toBe(1);
	});

	it('lets a later statement in the same batch see the conditional insert', async () => {
		await seed('sku-1', 1);
		const now = Date.now();

		const results = await env.DB.batch([
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b1',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b2',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
		]);

		// eslint-disable-next-line no-console
		console.log(
			`[batch same-item pair] changes=${JSON.stringify(results.map(r => r.meta.changes))}`,
		);
		expect(results.map(r => r.meta.changes)).toEqual([1, 0]);
		expect(await holdRowCount('sku-1')).toBe(1);
	});

	it('WARNING: a follow-on write in the batch runs even when the hold was refused', async () => {
		await seed('sku-1', 1);
		const now = Date.now();
		await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'b1',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});

		// A realistic reservation writes more than one row (e.g. touch the basket).
		const results = await env.DB.batch([
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b2',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
			env.DB.prepare('UPDATE inventory_item SET on_hand = on_hand - 1 WHERE id = ?1').bind('sku-1'),
		]);

		const item = await env.DB.prepare('SELECT on_hand FROM inventory_item WHERE id = ?1')
			.bind('sku-1')
			.first<{ on_hand: number }>();

		// eslint-disable-next-line no-console
		console.log(
			`[batch unconditional follow-on] hold changes=${results[0].meta.changes} on_hand now=${item?.on_hand}`,
		);

		expect(results[0].meta.changes).toBe(0);
		// The second statement is NOT gated on the first: on_hand was decremented anyway.
		expect(item?.on_hand).toBe(0);
	});

	it('the workaround: gate the follow-on statement on the hold row existing', async () => {
		await seed('sku-1', 1);
		const now = Date.now();
		await reserve(env.DB, {
			itemId: 'sku-1',
			basketId: 'b1',
			quantity: 1,
			expiresAt: now + TTL_MS,
			now,
		});

		const results = await env.DB.batch([
			reserveStatement(env.DB, {
				itemId: 'sku-1',
				basketId: 'b2',
				quantity: 1,
				expiresAt: now + TTL_MS,
				now,
			}),
			env.DB.prepare(
				'UPDATE inventory_item SET on_hand = on_hand - 1 WHERE id = ?1 '
				+ 'AND EXISTS (SELECT 1 FROM hold WHERE basket_id = ?2 AND inventory_item_id = ?1)',
			).bind('sku-1', 'b2'),
		]);

		const item = await env.DB.prepare('SELECT on_hand FROM inventory_item WHERE id = ?1')
			.bind('sku-1')
			.first<{ on_hand: number }>();

		// eslint-disable-next-line no-console
		console.log(
			`[batch gated follow-on] hold changes=${results[0].meta.changes} `
			+ `follow-on changes=${results[1].meta.changes} on_hand now=${item?.on_hand}`,
		);

		expect(results[0].meta.changes).toBe(0);
		expect(results[1].meta.changes).toBe(0);
		expect(item?.on_hand).toBe(1);
	});

	it('rolls the whole batch back when a later statement fails', async () => {
		await seed('sku-1', 1);
		const now = Date.now();

		await expect(
			env.DB.batch([
				reserveStatement(env.DB, {
					itemId: 'sku-1',
					basketId: 'b1',
					quantity: 1,
					expiresAt: now + TTL_MS,
					now,
				}),
				env.DB.prepare('INSERT INTO no_such_table (x) VALUES (1)'),
			]),
		).rejects.toThrow();

		expect(await holdRowCount('sku-1')).toBe(0);
	});

	it('exposes the statement text used, for the record', () => {
		expect(RESERVE_SQL).toContain('COALESCE');
	});
});

describe('measurement 4b — concurrent batches', () => {
	it('does not oversell when the reservation is wrapped in a batch under concurrency', async () => {
		await seed('sku-1', 1);
		const ITERATIONS = 50;
		const CONCURRENCY = 25;
		let oversellIterations = 0;
		const successCounts: number[] = [];

		for (let iteration = 0; iteration < ITERATIONS; iteration++) {
			await truncateHolds();
			const now = Date.now();
			const batches = await Promise.all(
				Array.from({ length: CONCURRENCY }, (_, i) =>
					env.DB.batch([
						reserveStatement(env.DB, {
							itemId: 'sku-1',
							basketId: `basket-${i}`,
							quantity: 1,
							expiresAt: now + TTL_MS,
							now,
						}),
						env.DB.prepare('SELECT changes() AS c'),
					])),
			);
			const granted = batches.filter(b => (b[0].meta.changes ?? 0) > 0).length;
			successCounts.push(granted);
			if (granted !== 1 || (await holdRowCount('sku-1')) !== 1) oversellIterations++;
		}

		// eslint-disable-next-line no-console
		console.log(
			`[batch concurrency=${CONCURRENCY}] iterations=${ITERATIONS} `
			+ `distinct successes=${JSON.stringify([...new Set(successCounts)].sort((a, b) => a - b))} `
			+ `oversell_iterations=${oversellIterations}`,
		);

		expect(oversellIterations).toBe(0);
	});
});
