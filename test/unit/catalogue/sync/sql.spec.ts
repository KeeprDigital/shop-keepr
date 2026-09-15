import { describe, expect, it } from 'vitest';
import { literal, packRows, STATEMENT_BYTES } from '../../../../server/catalogue/sync/sql';

describe('inline literals (spec §4.1: 100 bound parameters per statement, so bulk writes inline)', () => {
	it('escapes text and keeps every other value as SQL', () => {
		expect(literal(`Kiki-Jiki's "Mirror"`)).toBe(`'Kiki-Jiki''s "Mirror"'`);
		expect(literal('ピカチュウ')).toBe(`'ピカチュウ'`);
		expect(literal(42)).toBe('42');
		expect(literal(null)).toBe('NULL');
		expect(literal(true)).toBe('1');
		expect(literal(false)).toBe('0');
	});

	it('refuses a number D1 cannot store exactly', () => {
		expect(() => literal(1.5)).toThrow(/1\.5/);
		expect(() => literal(Number.NaN)).toThrow();
	});
});

describe('packing rows into statements under the 100 KB statement cap', () => {
	const head = 'INSERT INTO t (a) VALUES ';
	const tail = ' ON CONFLICT DO NOTHING';

	it('puts a small page in one statement', () => {
		expect(packRows(head, ['(1)', '(2)', '(3)'], tail)).toEqual(['INSERT INTO t (a) VALUES (1),(2),(3) ON CONFLICT DO NOTHING']);
	});

	it('emits nothing for no rows', () => {
		expect(packRows(head, [], tail)).toEqual([]);
	});

	it('splits so no statement exceeds the budget and every row lands once, in order', () => {
		const rows = Array.from({ length: 2_000 }, (_, i) => `('${'x'.repeat(200)}${i}')`);
		const statements = packRows(head, rows, tail);
		expect(statements.length).toBeGreaterThan(1);
		for (const statement of statements) {
			expect(new TextEncoder().encode(statement).byteLength).toBeLessThanOrEqual(STATEMENT_BYTES);
			expect(statement.startsWith(head)).toBe(true);
			expect(statement.endsWith(tail)).toBe(true);
		}
		const seen = statements.flatMap(s => s.slice(head.length, -tail.length).split('),(').length);
		expect(seen.reduce((a, b) => a + b, 0)).toBe(2_000);
		expect(statements[0]).toContain(`${'x'.repeat(200)}0')`);
		expect(statements.at(-1)).toContain(`${'x'.repeat(200)}1999')`);
	});

	it('measures bytes, not characters', () => {
		const rows = Array.from({ length: 1_000 }, () => `('${'ピ'.repeat(100)}')`);
		for (const statement of packRows(head, rows, tail)) {
			expect(new TextEncoder().encode(statement).byteLength).toBeLessThanOrEqual(STATEMENT_BYTES);
		}
	});
});
