import { describe, expect, it } from 'vitest';
import { STAFF_NAV } from '../../../app/utils/staff-nav';

describe('the staff sidebar nav', () => {
	it('lists every §8.1 item, in the spec\'s order, at the spec\'s route', () => {
		expect(STAFF_NAV.map(item => [item.label, item.to])).toEqual([
			['Lookup', '/'],
			['Transaction', '/transaction'],
			['Queue', '/queue'],
			['Customer Lists', '/lists'],
			['Large Buy', '/large-buy'],
			['Ingest', '/ingest'],
			['Inventory', '/inventory'],
			['Pinned Prices', '/pinned'],
			['History', '/history'],
			['Settings', '/settings'],
			['System', '/system'],
		]);
	});

	it('gives every item an icon', () => {
		for (const item of STAFF_NAV) {
			expect(item.icon, item.label).toMatch(/^i-lucide-/);
		}
	});
});
