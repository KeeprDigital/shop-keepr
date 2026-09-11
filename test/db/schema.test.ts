import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
	it('declares every application table STRICT', async () => {
		const { results } = await env.DB
			.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' AND name <> 'd1_migrations'`)
			.all<{ name: string; sql: string }>();

		expect(results.map(row => row.name)).toContain('store');
		for (const row of results) {
			expect(row.sql, row.name).toMatch(/\)\s*STRICT\s*$/);
		}
	});
});
