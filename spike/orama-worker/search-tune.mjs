/** Being fair to Orama: its default search is an OR over tokens. Tune it before judging. */
import { readFileSync } from 'node:fs';
import { create, insertMultiple, search } from '@orama/orama';
const names = JSON.parse(readFileSync(new URL('../typo-search/data/all-card-names.json', import.meta.url), 'utf8'));
const docs = names.map((n, i) => ({ id: `n-${i}`, name: n }));
const db = create({ schema: { name: 'string' } });
await insertMultiple(db, docs, 5000);
console.log(`indexed ${docs.length} distinct names\n`);
const cases = [
  ['Lightning Bolt', {}], ['Lightning Bolt', { threshold: 0 }],
  ['Lighming Bolt', { threshold: 0, tolerance: 2 }],
  ['Lighming Bolt', { threshold: 0, tolerance: 1 }],
  ['Lightnin', { threshold: 0 }],
  ['Lightnin', { threshold: 0, tolerance: 1 }],
  ['farfetchd', { threshold: 0, tolerance: 2 }],
  ['kozuki oden', { threshold: 0, tolerance: 2 }],
  ['flabebe', { threshold: 0, tolerance: 2 }],
  ['kaisa', { threshold: 0, tolerance: 2 }],
  ['bell mere', { threshold: 0, tolerance: 2 }],
  ['sheldred', { threshold: 0, tolerance: 2 }],
  ['jace mind sculptor', { threshold: 0 }],
  ['mind sculptor jace', { threshold: 0 }],
];
for (const [term, opts] of cases) {
  const t = Date.now();
  const r = await search(db, { term, limit: 3, ...opts });
  console.log(`"${term}" ${JSON.stringify(opts).padEnd(32)} ${String(Date.now()-t).padStart(4)}ms  ${String(r.count).padStart(6)} hits  top: ${r.hits.map(h=>h.document.name).join(' | ')}`);
}
