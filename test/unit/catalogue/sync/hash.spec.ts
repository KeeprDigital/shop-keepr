import { describe, expect, it } from 'vitest';
import { contentHash } from '../../../../server/catalogue/sync/hash';

describe('content hash', () => {
	it('is the same for the same record however its keys are ordered', async () => {
		const a = await contentHash({ kind: 'set', code: 'lea', name: 'Alpha', nested: { x: 1, y: [1, 2] } });
		const b = await contentHash({ nested: { y: [1, 2], x: 1 }, name: 'Alpha', code: 'lea', kind: 'set' });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when any value changes', async () => {
		const before = await contentHash({ kind: 'set', code: 'lea', name: 'Alpha' });
		const after = await contentHash({ kind: 'set', code: 'lea', name: 'Alpha ' });
		expect(after).not.toBe(before);
	});

	it('tells null from absent and a list from a joined string', async () => {
		expect(await contentHash({ a: null })).not.toBe(await contentHash({}));
		expect(await contentHash({ a: ['R', 'G'] })).not.toBe(await contentHash({ a: 'R,G' }));
	});
});
