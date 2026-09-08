/**
 * Item 6: how much typo tolerance do the cheap engine-agnostic columns actually buy?
 *
 * Indexes all 38,001 real card names under each mechanism and measures, per error
 * class: recall (did the right name come back at all) and, for the mechanisms that
 * return a set rather than a single row, how big that set is — because a mechanism
 * that returns the right name inside 900 candidates has not solved the problem.
 */
import { loadCorpora, allNames } from './corpus.mjs';
import { doubleMetaphone } from 'double-metaphone';
import {
	damerauLevenshtein, fold, foldSorted, foldSpacingApostrophes, metaphoneKey,
	metaphoneKeySorted, trigrams,
} from './mechanisms.mjs';

const doubleMetaphonePrimary = t => doubleMetaphone(t)[0] || t;
import { buildQueries } from './misspellings.mjs';

const corpora = loadCorpora();
const names = allNames(corpora);
console.log(`Corpus: ${names.length} distinct real card names across four Game Systems.\n`);

// ---------------------------------------------------------------- build indexes
const t0 = Date.now();
const byExact = new Map();
const byFold = new Map();
const byFoldSorted = new Map();
const byMeta = new Map();
const byMetaSorted = new Map();
const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
for (const n of names) {
	push(byExact, n, n);
	push(byFold, fold(n), n);
	push(byFoldSorted, foldSorted(n), n);
	push(byMeta, metaphoneKey(n), n);
	push(byMetaSorted, metaphoneKeySorted(n), n);
}
console.log(`Indexes built in ${Date.now() - t0} ms.\n`);

// --------------------------------------------------------------- key collisions
console.log('=== KEY COLLISION COST ===');
console.log('A key that maps many names to one bucket returns a big candidate set.\n');
for (const [label, m] of [
	['exact name', byExact], ['folded name', byFold], ['folded, tokens sorted', byFoldSorted],
	['Double Metaphone', byMeta], ['Double Metaphone, sorted', byMetaSorted],
]) {
	const sizes = [...m.values()].map(a => a.length).sort((a, b) => b - a);
	const collided = sizes.filter(s => s > 1);
	const namesInCollisions = collided.reduce((a, b) => a + b, 0);
	console.log(
		`${label.padEnd(26)} keys=${String(m.size).padStart(6)}  `
		+ `names in a shared bucket=${String(namesInCollisions).padStart(6)} (${(100 * namesInCollisions / names.length).toFixed(1)}%)  `
		+ `largest bucket=${sizes[0]}  p99 bucket=${sizes[Math.floor(sizes.length * 0.01)]}`,
	);
}
console.log('\nWorst Double Metaphone buckets (what a phonetic-only lookup would return):');
[...byMeta.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).forEach(([k, v]) => {
	console.log(`  "${k}" -> ${v.length} names: ${v.slice(0, 6).join(' / ')}${v.length > 6 ? ' ...' : ''}`);
});

// ------------------------------------------------------------------- mechanisms
const exactLookup = q => byExact.get(q) ?? [];
const foldLookup = q => byFold.get(fold(q)) ?? [];
const foldSortedLookup = q => byFoldSorted.get(foldSorted(q)) ?? [];
const metaLookup = q => byMeta.get(metaphoneKey(q)) ?? [];
const metaSortedLookup = q => byMetaSorted.get(metaphoneKeySorted(q)) ?? [];
const foldThenMeta = (q) => { const f = foldLookup(q); return f.length ? f : metaLookup(q); };
const foldSortedThenMetaSorted = (q) => { const f = foldSortedLookup(q); return f.length ? f : metaSortedLookup(q); };

// pg_trgm / hand-rolled-D1 model: rank every name by trigram similarity, take top 10.
// Brute force over 38k names per query, so it is sampled; it is the SEMANTICS under
// test here, not the speed. Speed is measured in the D1 and Postgres spikes.
const nameTrigrams = names.map(n => [n, trigrams(n)]);
function trigramTop(q, k = 10, threshold = 0.3) {
	const Q = trigrams(q);
	const scored = [];
	for (const [n, T] of nameTrigrams) {
		let shared = 0;
		for (const t of Q) if (T.has(t)) shared++;
		if (!shared) continue;
		const sim = shared / (Q.size + T.size - shared);
		if (sim >= threshold) scored.push([n, sim]);
	}
	scored.sort((a, b) => b[1] - a[1]);
	return scored.slice(0, k).map(s => s[0]);
}

// The ceiling: what a real typo-tolerant engine does. Damerau-Levenshtein <= 2 on
// the folded string, which is roughly Typesense/Algolia at num_typos=2.
function dlTop(q, k = 10) {
	const fq = fold(q);
	const scored = [];
	for (const n of names) {
		const d = damerauLevenshtein(fq, fold(n), 2);
		if (d <= 2) scored.push([n, d]);
	}
	scored.sort((a, b) => a[1] - b[1]);
	return scored.slice(0, k).map(s => s[0]);
}

// --------------------------------------------------- token-based mechanisms
// The whole-string mechanisms above unfairly penalise the partial-recall classes,
// because every real engine tokenises. These four are the realistic comparison:
// 9 is what D1's FTS5 already does today; 10 adds the phonetic column; 11 is what
// Typesense / Meilisearch / Algolia do; 12 is the hand-rolled D1 trigram table.
const postingsExact = new Map(); // folded token -> Set(name)
const postingsMeta = new Map(); // metaphone of token -> Set(name)
const addPosting = (m, k, v) => { const s = m.get(k); if (s) s.add(v); else m.set(k, new Set([v])); };
for (const n of names) {
	for (const t of fold(n).split(' ').filter(Boolean)) {
		addPosting(postingsExact, t, n);
		addPosting(postingsMeta, doubleMetaphonePrimary(t), n);
	}
}
const allTokens = [...postingsExact.keys()];

function intersectAll(sets) {
	if (!sets.length) return [];
	sets.sort((a, b) => a.size - b.size);
	const out = [];
	outer: for (const v of sets[0]) {
		for (let i = 1; i < sets.length; i++) if (!sets[i].has(v)) continue outer;
		out.push(v);
	}
	return out;
}

/** 9: FTS5 today. Every query token must match a name token exactly. Any order. */
function tokenAnd(q, cap = 10) {
	const qt = fold(q).split(' ').filter(Boolean);
	const sets = qt.map(t => postingsExact.get(t)).filter(Boolean);
	if (sets.length !== qt.length) return [];
	return intersectAll(sets).slice(0, cap);
}

/** 10: FTS5 plus a phonetic key column. Exact token first, phonetic key as fallback. */
function tokenAndMeta(q, cap = 10) {
	const exact = tokenAnd(q, cap);
	if (exact.length) return exact;
	const qt = fold(q).split(' ').filter(Boolean);
	const sets = qt.map(t => postingsExact.get(t) ?? postingsMeta.get(doubleMetaphonePrimary(t))).filter(Boolean);
	if (sets.length !== qt.length) return [];
	return intersectAll(sets).slice(0, cap);
}

/** 11: a real typo-tolerant engine. Per-token Damerau-Levenshtein <= 1 (2 if long). */
function tokenAndFuzzy(q, cap = 10) {
	const exact = tokenAnd(q, cap);
	if (exact.length) return exact;
	const qt = fold(q).split(' ').filter(Boolean);
	const sets = qt.map((t) => {
		const hit = postingsExact.get(t);
		if (hit) return hit;
		const budget = t.length >= 7 ? 2 : t.length >= 4 ? 1 : 0;
		if (!budget) return null;
		const union = new Set();
		for (const cand of allTokens) {
			if (Math.abs(cand.length - t.length) > budget) continue;
			if (damerauLevenshtein(t, cand, budget) <= budget) {
				for (const n of postingsExact.get(cand)) union.add(n);
			}
		}
		return union.size ? union : null;
	}).filter(Boolean);
	if (sets.length !== qt.length) return [];
	return intersectAll(sets).slice(0, cap);
}

const MECHANISMS = [
	['1 exact name', exactLookup, false],
	['2 folded column', foldLookup, false],
	['3 folded + token-sorted', foldSortedLookup, false],
	['4 metaphone column', metaLookup, false],
	['5 folded, then metaphone', foldThenMeta, false],
	['6 fold+sort, then meta+sort', foldSortedThenMetaSorted, false],
	['7 trigram sim >= 0.3, top10', trigramTop, true],
	['8 Damerau-Lev <= 2, top10', dlTop, true],
	['9 token AND (FTS5 today)', tokenAnd, false],
	['10 token AND + metaphone', tokenAndMeta, false],
	['11 token AND + fuzzy token', tokenAndFuzzy, true],
];

// --------------------------------------------------------------------- evaluate
const PER_CLASS = 300;
const SLOW_PER_CLASS = 60; // brute-force mechanisms are O(corpus) per query
const queries = buildQueries(names, PER_CLASS);

console.log('\n\n=== EXPOSURE: how many of the 38,001 real names can even suffer each class ===\n');
for (const [cls, { exposedCount, exposedShare }] of Object.entries(queries)) {
	console.log(`${cls.padEnd(30)} ${(exposedShare * 100).toFixed(1).padStart(5)}%  (${exposedCount})`);
}

console.log('\n\n=== RECALL BY ERROR CLASS (is the right name anywhere in what came back?) ===\n');
const header = ['error class'.padEnd(30), ...MECHANISMS.map(m => m[0].slice(0, 10).padStart(11))].join('');
console.log(header);
console.log('-'.repeat(header.length));

const totals = MECHANISMS.map(() => ({ hit: 0, n: 0, cand: 0 }));
for (const [cls, { pairs }] of Object.entries(queries)) {
	if (!pairs.length) { console.log(`${cls.padEnd(30)}${'(no exposed names)'.padStart(11)}`); continue; }
	const cells = MECHANISMS.map(([, fn, slow], mi) => {
		const use = slow ? pairs.slice(0, SLOW_PER_CLASS) : pairs;
		let hit = 0; let cand = 0;
		for (const { name, query } of use) {
			const got = fn(query);
			cand += got.length;
			if (got.includes(name)) hit++;
		}
		totals[mi].hit += hit; totals[mi].n += use.length; totals[mi].cand += cand;
		return `${((100 * hit) / use.length).toFixed(0)}%`.padStart(11);
	});
	console.log(cls.padEnd(30) + cells.join(''));
}
console.log('-'.repeat(header.length));
console.log(
	'UNWEIGHTED mean over classes'.padEnd(30)
	+ totals.map(t => `${((100 * t.hit) / t.n).toFixed(0)}%`.padStart(11)).join(''),
);
console.log(
	'mean candidates returned'.padEnd(30)
	+ totals.map(t => (t.cand / t.n).toFixed(1).padStart(11)).join(''),
);
console.log('\nNOTE: the mean is UNWEIGHTED across error classes. It is not a coverage');
console.log('figure and must not be quoted as one — see misspellings.mjs. Read the rows.');
