/**
 * Issue #25 item 3, stage 1: build a 150,000-Printing Orama index in plain Node
 * and find out what it weighs.
 *
 * Node first, deliberately. If the index does not fit in a Worker's 128 MB memory
 * ceiling or cannot be loaded inside the startup CPU budget, that is decidable
 * from the serialised size and the restore cost, and it is much cheaper to find
 * out here than inside workerd. Stage 2 (`worker.test.ts`) then runs the restore
 * and the search inside real workerd.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { create, insertMultiple, search } from '@orama/orama';
import { persist } from '@orama/plugin-data-persistence';

const names = JSON.parse(readFileSync(new URL('../typo-search/data/all-card-names.json', import.meta.url), 'utf8'));

const GAMES = [['magic', 110_000], ['pokemon', 20_000], ['onepiece', 13_000], ['riftbound', 4_000], ['tail', 3_000]];

// The document shape the truncation problem (#16) demands: if stock quantity and
// Sell Price are NOT in the index, a search can only return a top-N candidate set
// to filter and sort elsewhere. So they are in it, and their cost is measured.
const docs = [];
let i = 0;
for (const [game, count] of GAMES) {
	for (let n = 0; n < count; n++, i++) {
		docs.push({
			id: `p-${String(i).padStart(7, '0')}`,
			name: names[i % names.length],
			game: game,
			rarity: ['common', 'uncommon', 'rare', 'mythic'][i % 4],
			sellPrice: (i * 37) % 50_000,
			quantity: i % 7,
		});
	}
}
console.log(`Documents: ${docs.length}, distinct names: ${new Set(docs.map(d => d.name)).size}`);

const mem = () => Math.round(process.memoryUsage().heapUsed / 1e6);
console.log(`heap before create: ${mem()} MB`);

const t0 = Date.now();
const db = create({
	schema: {
		name: 'string',
		game: 'enum',
		rarity: 'enum',
		sellPrice: 'number',
		quantity: 'number',
	},
});
await insertMultiple(db, docs, 5_000);
const buildMs = Date.now() - t0;
console.log(`Index built in ${buildMs} ms. heap after: ${mem()} MB`);

// Sanity: does it actually do typo-tolerant search?
for (const [q, tol] of [['Lightning Bolt', 0], ['Lighming Bolt', 2], ['farfetchd', 2], ['kozuki oden', 2]]) {
	const r = await search(db, { term: q, tolerance: tol, limit: 3, properties: ['name'] });
	console.log(`  search "${q}" tolerance=${tol} -> ${r.count} hits, top: ${r.hits.map(h => h.document.name).join(' | ')}`);
}

// Serialise. `persist` returns an in-memory value; the `server` entry point writes
// to the filesystem and is unusable in a Worker, so this is the only path an R2- or
// KV-backed Worker could take.
for (const format of ['json', 'binary', 'dpack']) {
	try {
		const tS = Date.now();
		const blob = await persist(db, format);
		const bytes = typeof blob === 'string' ? Buffer.byteLength(blob, 'utf8') : Buffer.from(blob).length;
		console.log(`persist("${format}"): ${(bytes / 1e6).toFixed(1)} MB in ${Date.now() - tS} ms (typeof ${typeof blob})`);
		if (format === 'json') writeFileSync(new URL('./data/index.json', import.meta.url), blob);
		if (format === 'binary') writeFileSync(new URL('./data/index.msp', import.meta.url), Buffer.from(blob));
	}
	catch (e) {
		console.log(`persist("${format}"): FAILED — ${e.message}`);
	}
}
