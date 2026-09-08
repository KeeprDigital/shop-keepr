/**
 * Orama's typo-tolerance quality, measured on the same error classes as
 * `spike/typo-search/`, so the numbers sit in the same table as the cheap columns
 * and pg_trgm. Recall at 1, 3 and 10 — because "the right card is in the top 200"
 * is not a search result a kiosk customer can use.
 */
import { readFileSync } from 'node:fs';
import { create, insertMultiple, search } from '@orama/orama';
import { buildQueries } from '../typo-search/misspellings.mjs';

const names = JSON.parse(readFileSync(new URL('../typo-search/data/all-card-names.json', import.meta.url), 'utf8'));
const db = create({ schema: { name: 'string' } });
await insertMultiple(db, names.map((n, i) => ({ id: `n-${i}`, name: n })), 5000);

const queries = buildQueries(names, 200);
const CONFIGS = [
  ['threshold 0, no tolerance', { threshold: 0 }],
  ['threshold 0, tolerance 1', { threshold: 0, tolerance: 1 }],
  ['threshold 0, tolerance 2', { threshold: 0, tolerance: 2 }],
  ['default (OR), tolerance 2', { tolerance: 2 }],
];
const K = [1, 3, 10];

console.log('\nRecall@k, Orama 3.1.18, 38,001 distinct card names\n');
console.log('error class'.padEnd(32) + CONFIGS.map(c => c[0].slice(0,24).padStart(26)).join(''));
console.log(' '.repeat(32) + CONFIGS.map(() => '  @1   @3  @10   ms'.padStart(26)).join(''));
console.log('-'.repeat(32 + 26*CONFIGS.length));
for (const [cls, { pairs }] of Object.entries(queries)) {
  if (!pairs.length) continue;
  const cells = [];
  for (const [, opts] of CONFIGS) {
    const hit = [0,0,0]; let ms = 0;
    for (const { name, query } of pairs) {
      const t = Date.now();
      const r = await search(db, { term: query, limit: 10, ...opts });
      ms += Date.now() - t;
      const rank = r.hits.findIndex(h => h.document.name === name);
      K.forEach((k, ki) => { if (rank >= 0 && rank < k) hit[ki]++; });
    }
    cells.push((hit.map(h => `${Math.round(100*h/pairs.length)}%`.padStart(5)).join('') + `${(ms/pairs.length).toFixed(1)}`.padStart(6)).padStart(26));
  }
  console.log(cls.padEnd(32) + cells.join(''));
}
