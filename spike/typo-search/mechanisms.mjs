/**
 * The mechanisms under test. Each takes a query and returns a ranked candidate list
 * of names. Every one is implementable as one or two ordinary indexed columns, so
 * they work on ANY engine including D1 — which is the whole point of item 6.
 */
import { doubleMetaphone } from 'double-metaphone';

/**
 * The folded name column. NFKD, strip combining marks, lowercase, strip everything
 * that is not a letter or digit, collapse whitespace.
 *
 * NFKD (not NFD) is deliberate: it also decomposes compatibility forms, which is
 * what turns "Pokégear 3.0" and full-width characters into something typeable.
 * Symbols that decompose to nothing (delta, diamond, star, heart, Mars/Venus signs)
 * are dropped entirely, which is correct — a customer cannot type them.
 */
export function fold(s) {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		// Apostrophes are DELETED, not spaced. This one line is worth a measured 57
		// points of recall on the "punctuation deleted" class: a customer types
		// "Farfetchd", never "Farfetch d". Every other separator becomes a space,
		// which is what Lucene's standard analyser does and what pg_trgm assumes.
		.replace(/['’ʼ‘`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** The naive fold, kept so the findings can quote what the apostrophe rule buys. */
export function foldSpacingApostrophes(s) {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/** Folded, with tokens sorted — makes matching order-insensitive. */
export function foldSorted(s) {
	return fold(s).split(' ').sort().join(' ');
}

/** Double Metaphone primary key, per token, joined. Computed on the folded form. */
export function metaphoneKey(s) {
	return fold(s)
		.split(' ')
		.filter(Boolean)
		.map(t => doubleMetaphone(t)[0] || t)
		.join(' ');
}

/** Double Metaphone with tokens sorted. */
export function metaphoneKeySorted(s) {
	return fold(s)
		.split(' ')
		.filter(Boolean)
		.map(t => doubleMetaphone(t)[0] || t)
		.sort()
		.join(' ');
}

/** Trigram set of a folded string, padded the way pg_trgm pads: "  x" ... "y  ". */
export function trigrams(s) {
	const out = new Set();
	for (const word of fold(s).split(' ').filter(Boolean)) {
		const padded = `  ${word} `;
		for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
	}
	return out;
}

/** pg_trgm's similarity(): |shared| / |union|. */
export function trigramSimilarity(a, b) {
	const A = trigrams(a);
	const B = trigrams(b);
	let shared = 0;
	for (const t of A) if (B.has(t)) shared++;
	return shared / (A.size + B.size - shared);
}

/** Damerau-Levenshtein with a cap, for the "what a real engine can do" ceiling. */
export function damerauLevenshtein(a, b, cap = 3) {
	if (Math.abs(a.length - b.length) > cap) return cap + 1;
	const prev2 = [];
	let prev = [];
	let cur = [];
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				v = Math.min(v, prev2[j - 2] + 1);
			}
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > cap) return cap + 1;
		prev2.length = 0;
		prev2.push(...prev);
		prev = cur;
	}
	return prev[b.length];
}
