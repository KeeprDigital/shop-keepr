import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDb } from '../../server/db/client';
import { readHealth } from '../../server/services/health';
import { STORE_ID } from '../../server/utils/store';

describe('health', () => {
	it('reads the one Store from D1', async () => {
		const health = await readHealth(createDb(env.DB));

		expect(health.store.id).toBe(STORE_ID);
		expect(health.store.name).toBeTypeOf('string');
		expect(health.checkedAt).toBeGreaterThan(1_700_000_000_000);
	});
});
