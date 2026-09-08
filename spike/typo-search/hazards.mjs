/**
 * Item 7, the measurable half: what hazards do real card names actually carry?
 *
 * We cannot measure which typos users make — this application has no users and no
 * query log. What we CAN measure, and what nobody has, is the frequency of each
 * hazard in the names themselves. A hazard nobody's names carry cannot cause a miss;
 * a hazard 30% of names carry will cause misses in proportion to how often those
 * names are searched.
 *
 * Also measures token-length distribution, because every hosted engine gates typo
 * tolerance on word length (Meilisearch: no typos at all below 5 characters;
 * Typesense min_len_1typo=4; Algolia minWordSizefor1Typo=4).
 */
import { loadCorpora } from './corpus.mjs';

const COMBINING = /\p{M}/u;

const HAZARDS = {
	'combining marks after NFD (accents)': n => COMBINING.test(n.normalize('NFD')),
	'non-ASCII code points': n => /[^\x00-\x7F]/.test(n),
	'straight apostrophe \'': n => n.includes("'"),
	'curly apostrophe ’': n => n.includes('’'),
	'hyphen -': n => n.includes('-'),
	'period .': n => n.includes('.'),
	'comma ,': n => n.includes(','),
	'ampersand &': n => n.includes('&'),
	'colon :': n => n.includes(':'),
	'exclamation / question': n => /[!?]/.test(n),
	'double quote "': n => n.includes('"'),
	'any punctuation at all': n => /[^\p{L}\p{N}\s]/u.test(n),
	'digit': n => /\p{N}/u.test(n),
	'multi-token (>= 2 words)': n => n.trim().split(/\s+/).length >= 2,
	'>= 4 tokens': n => n.trim().split(/\s+/).length >= 4,
};

function pct(a, b) {
	return `${((a / b) * 100).toFixed(1)}%`;
}

function tokenise(name) {
	return name
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

const corpora = loadCorpora();
const sets = [...Object.values(corpora), {
	name: 'ALL (deduped)',
	provenance: '-',
	names: [...new Set(Object.values(corpora).flatMap(c => c.names))],
}];

console.log('\n=== CORPUS ===');
for (const c of sets) console.log(`${c.name.padEnd(16)} ${String(c.names.length).padStart(7)} distinct names   ${c.provenance}`);

console.log('\n=== HAZARD FREQUENCY (share of distinct names carrying the hazard) ===');
const head = ['hazard'.padEnd(34), ...sets.map(c => c.name.padStart(14))].join('');
console.log(head);
for (const [label, test] of Object.entries(HAZARDS)) {
	const cells = sets.map((c) => {
		const hits = c.names.filter(test).length;
		return `${pct(hits, c.names.length)} (${hits})`.padStart(14);
	});
	console.log(label.padEnd(34) + cells.join(''));
}

console.log('\n=== TOKEN LENGTH DISTRIBUTION (every token of every name) ===');
console.log('Why: Meilisearch allows NO typos on tokens of 4 chars or fewer; Typesense');
console.log('min_len_1typo=4; Algolia minWordSizefor1Typo=4, minWordSizefor2Typos=8.\n');
for (const c of sets) {
	const toks = c.names.flatMap(tokenise);
	const buckets = { '1-3': 0, 4: 0, '5-6': 0, '7-8': 0, '9+': 0 };
	for (const t of toks) {
		if (t.length <= 3) buckets['1-3']++;
		else if (t.length === 4) buckets[4]++;
		else if (t.length <= 6) buckets['5-6']++;
		else if (t.length <= 8) buckets['7-8']++;
		else buckets['9+']++;
	}
	const n = toks.length;
	console.log(
		`${c.name.padEnd(16)} tokens=${String(n).padStart(7)}  `
		+ Object.entries(buckets).map(([k, v]) => `${k}:${pct(v, n)}`).join('  '),
	);
}

console.log('\n=== NAMES WHOSE *ENTIRE* NAME IS ONE SHORT TOKEN ===');
console.log('These get zero typo tolerance from Meilisearch by default.');
for (const c of sets) {
	const short = c.names.filter((n) => {
		const t = tokenise(n);
		return t.length === 1 && t[0].length <= 4;
	});
	console.log(`${c.name.padEnd(16)} ${pct(short.length, c.names.length)} (${short.length})  e.g. ${short.slice(0, 8).join(', ')}`);
}

console.log('\n=== APOSTROPHE FORM: what a real corpus uses vs what a phone types ===');
for (const c of sets) {
	const straight = c.names.filter(n => n.includes("'")).length;
	const curly = c.names.filter(n => n.includes('’')).length;
	console.log(`${c.name.padEnd(16)} straight=${straight}  curly=${curly}`);
}

console.log('\n=== SAMPLE OF THE HARDEST NAMES (accents + punctuation) ===');
for (const c of Object.values(corpora)) {
	const hard = c.names.filter(n => COMBINING.test(n.normalize('NFD')));
	console.log(`\n${c.name} — ${hard.length} accented names, sample:`);
	console.log(`  ${hard.slice(0, 14).join(' | ')}`);
}
