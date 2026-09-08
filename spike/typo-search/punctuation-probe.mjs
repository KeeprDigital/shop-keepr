/**
 * Focused probe: the folded name column is a two-way trade on punctuation, and the
 * trade is resolvable. A customer who omits an apostrophe types "Farfetchd"; a
 * customer who replaces a hyphen types "Ho Oh". One fold rule cannot serve both.
 * This measures the naive rule, the apostrophe-deleting rule, and the two-key fix.
 */
import { loadCorpora, allNames } from './corpus.mjs';
import { fold, foldSpacingApostrophes } from './mechanisms.mjs';
import { buildQueries } from './misspellings.mjs';

const names = allNames(loadCorpora());
const noSpace = s => fold(s).replace(/ /g, '');

const idxNaive = new Map(), idxApos = new Map(), idxNoSpace = new Map();
const add = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
for (const n of names) {
  add(idxNaive, foldSpacingApostrophes(n), n);
  add(idxApos, fold(n), n);
  add(idxNoSpace, noSpace(n), n);
}

const MECHS = [
  ['fold, apostrophe -> space (naive)', q => idxNaive.get(foldSpacingApostrophes(q)) ?? []],
  ['fold, apostrophe deleted', q => idxApos.get(fold(q)) ?? []],
  ['fold + space-stripped 2nd key', (q) => {
    const a = idxApos.get(fold(q)); if (a) return a;
    return idxNoSpace.get(noSpace(q)) ?? [];
  }],
];

const queries = buildQueries(names, 1500);
const CLASSES = ['C. punctuation deleted', 'D. punctuation -> space', 'E. straight -> curly apostrophe', 'A. dropped diacritic', 'B. untypeable symbol dropped'];

console.log('\nRecall on the punctuation and normalisation classes, 1500 pairs each:\n');
console.log('error class'.padEnd(34) + MECHS.map(m => m[0].slice(0, 30).padStart(34)).join(''));
console.log('-'.repeat(34 + 34 * MECHS.length));
for (const cls of CLASSES) {
  const pairs = queries[cls].pairs;
  const cells = MECHS.map(([, fn]) => {
    let hit = 0;
    for (const { name, query } of pairs) if (fn(query).includes(name)) hit++;
    return `${((100 * hit) / pairs.length).toFixed(0)}%  (n=${pairs.length})`.padStart(34);
  });
  console.log(cls.padEnd(34) + cells.join(''));
}

console.log('\nCollision cost of the space-stripped second key:');
const sizes = [...idxNoSpace.values()].map(a => a.length).sort((a, b) => b - a);
const shared = sizes.filter(s => s > 1).reduce((a, b) => a + b, 0);
console.log(`  keys=${idxNoSpace.size}  names sharing a key=${shared} (${(100 * shared / names.length).toFixed(2)}%)  largest bucket=${sizes[0]}`);
[...idxNoSpace.entries()].filter(([, v]) => v.length > 1).slice(0, 5).forEach(([k, v]) => console.log(`    "${k}" -> ${v.join(' / ')}`));
