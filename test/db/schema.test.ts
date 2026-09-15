import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('schema', () => {
	it('declares every application table STRICT', async () => {
		const { results } = await env.DB
			.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' AND name <> 'd1_migrations'`)
			.all<{ name: string; sql: string }>();

		expect(results.map(row => row.name)).toContain('store');
		expect(results.map(row => row.name)).toContain('mtg_printing');
		// An FTS5 index is a virtual table with shadow tables of its own; neither can be STRICT.
		const ownTables = results.filter(row => !/_fts(?:_\w+)?$/.test(row.name));
		for (const row of ownTables) {
			expect(row.sql, row.name).toMatch(/\)\s*STRICT\s*$/);
		}
	});
});
