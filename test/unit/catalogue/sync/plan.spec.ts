import type { ParsedRecord } from '../../../../server/catalogue/client';
import type { CatalogueRecord, PrintingRecord } from '../../../../server/catalogue/generated/types.gen';
import type { Existing } from '../../../../server/catalogue/sync/plan';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../../../../server/catalogue/sync/hash';
import { emptyExisting, planPage, vocabularyKey } from '../../../../server/catalogue/sync/plan';
import { fixtureRecords } from '../../../support/catalogue-fixture';

const magic = fixtureRecords().filter(r => r.game === 'magic');
const ok = (records: CatalogueRecord[]): ParsedRecord<CatalogueRecord>[] => records.map(record => ({ ok: true, record }));

/** The Mirror as it stands after `records` were applied. */
async function mirrorOf(records: CatalogueRecord[]): Promise<Existing> {
	const existing = emptyExisting();
	for (const record of records) {
		const row = { hash: await contentHash(record), cursor: record.cursor };
		if (record.kind === 'printing') {
			existing.printings.set(record.id, row);
		}
		else if (record.kind === 'set') {
			existing.sets.set(record.code, row);
		}
		else {
			existing.vocabularies.set(vocabularyKey(record.facet, record.code), row);
		}
	}
	return existing;
}

const bolt = magic.find((r): r is PrintingRecord => r.kind === 'printing' && r.id === 'prt-magic-m10-146')!;

describe('planning a page (ADR 0009: hash-compare on every write makes seed, delta and reconcile one code path)', () => {
	it('inserts everything into an empty Mirror, sets and vocabularies before Printings', async () => {
		const plan = await planPage(ok(magic), emptyExisting(), { fullWalk: true });
		expect(plan.counts).toEqual({ seen: magic.length, written: magic.length, quarantined: 0, drifted: 0 });
		expect(plan.sets.map(w => w.record.code)).toEqual(['lea', 'm10', 'unh', 'sta', 'neo', 'mom', 'ptc']);
		expect(plan.vocabularies).toHaveLength(20);
		expect(plan.printings).toHaveLength(17);
		expect(plan.quarantined).toEqual([]);
		expect(plan.printings.find(w => w.record.id === bolt.id)).toMatchObject({ hash: await contentHash(bolt) });
		expect(plan.printingsSeen).toBe(17);
	});

	it('writes nothing when every record hashes the same as the Mirror', async () => {
		const plan = await planPage(ok(magic), await mirrorOf(magic), { fullWalk: true });
		expect(plan.counts).toEqual({ seen: magic.length, written: 0, quarantined: 0, drifted: 0 });
		expect([...plan.sets, ...plan.vocabularies, ...plan.printings]).toEqual([]);
	});

	it('updates exactly the record that changed', async () => {
		const renamed = { ...bolt, name: 'Lightning Bolt (misprint)' };
		const page = magic.map(r => (r === bolt ? renamed : r));
		const plan = await planPage(ok(page), await mirrorOf(magic), { fullWalk: false });
		expect(plan.counts).toEqual({ seen: magic.length, written: 1, quarantined: 0, drifted: 0 });
		expect(plan.printings).toHaveLength(1);
		expect(plan.printings[0]).toMatchObject({ record: renamed });
	});

	it('counts a change found by a full walk as drift', async () => {
		const page = magic.map(r => (r === bolt ? { ...bolt, rarity: 'uncommon' } : r));
		const plan = await planPage(ok(page), await mirrorOf(magic), { fullWalk: true });
		expect(plan.counts).toMatchObject({ written: 1, drifted: 1 });
	});

	it('never applies a record whose cursor is behind the row it would replace', async () => {
		const older = { ...bolt, cursor: 'magic-0010', name: 'Stale Bolt' };
		const plan = await planPage(ok([older]), await mirrorOf(magic), { fullWalk: false });
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 0, drifted: 0 });
		expect(plan.printings).toEqual([]);
	});

	it('applies a record at the same cursor whose content differs', async () => {
		const plan = await planPage(ok([{ ...bolt, name: 'Re-issued Bolt' }]), await mirrorOf(magic), { fullWalk: false });
		expect(plan.printings).toHaveLength(1);
	});

	it('quarantines a record that failed validation, with its raw payload, and carries on', async () => {
		const broken = { kind: 'printing', cursor: 'magic-0099', game: 'magic', id: 'prt-broken' };
		const issues = [{ code: 'invalid_type', path: ['card_id'], message: 'Required' }];
		const plan = await planPage([{ ok: false, raw: broken, issues }, ...ok([bolt])], emptyExisting(), { fullWalk: false });
		expect(plan.counts).toEqual({ seen: 2, written: 1, quarantined: 1, drifted: 0 });
		expect(plan.printingsSeen).toBe(2);
		expect(plan.quarantined).toEqual([{
			reason: 'validation_failed',
			recordKind: 'printing',
			recordId: 'prt-broken',
			cursor: 'magic-0099',
			detail: { issues },
			raw: broken,
		}]);
	});

	it('quarantines a Printing whose colour has no column, naming the facet and value', async () => {
		const purple = { ...bolt, attributes: { ...bolt.attributes, colour_identity: ['R', 'P'] } };
		const plan = await planPage(ok([purple]), emptyExisting(), { fullWalk: false });
		expect(plan.counts).toEqual({ seen: 1, written: 0, quarantined: 1, drifted: 0 });
		expect(plan.quarantined[0]).toMatchObject({
			reason: 'unknown_facet_value',
			recordKind: 'printing',
			recordId: bolt.id,
			cursor: bolt.cursor,
			detail: { facet: 'colour_identity', value: 'P' },
			raw: purple,
		});
	});

	it('describes a payload that is not even an object without guessing at it', async () => {
		const plan = await planPage([{ ok: false, raw: 'garbage', issues: [] }], emptyExisting(), { fullWalk: false });
		expect(plan.quarantined[0]).toMatchObject({ recordKind: null, recordId: null, cursor: null, raw: 'garbage' });
	});
});
