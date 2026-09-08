/**
 * The misspelling model for item 7.
 *
 * HONESTY NOTE, and it is the most important sentence in this spike: nobody has a
 * query log for this application, so NO figure here is a frequency of real user
 * behaviour. What this file does is take REAL card names from the four Game Systems
 * and apply thirteen documented, mechanically-defined error classes to them. That
 * makes the per-class recall figures real measurements OF THE MECHANISMS, and makes
 * the class WEIGHTS an assumption. The findings report per-class recall and refuses
 * to report a single weighted "coverage" number, because that number would be an
 * invention.
 *
 * The classes are drawn from the standard spelling-error taxonomy (Damerau's four
 * single-edit operations) plus the classes specific to this domain: dropped
 * diacritics, dropped and substituted punctuation, smart-quote substitution,
 * untypeable symbols, Japanese romanisation variants, and partial recall.
 */

const QWERTY_NEIGHBOURS = {
	a: 'qwsz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc',
	g: 'ftyhbv', h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop',
	m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awedxz',
	t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
};

const PHONETIC_SUBS = [
	[/ph/g, 'f'], [/^k/, 'c'], [/ck/g, 'k'], [/c([aou])/g, 'k$1'],
	[/x/g, 'z'], [/tion/g, 'shun'], [/ei/g, 'ie'], [/ie/g, 'ei'],
	[/([bcdfglmnprst])\1/g, '$1'], [/y/g, 'i'], [/z/g, 's'], [/qu/g, 'kw'],
];

// Romanisation pairs. Japanese long vowels romanise several ways, and Bandai's
// official English One Piece names use the "ou"/"uu" convention while fandom,
// the anime subtitles and most players use the bare vowel. Both are "correct".
const ROMANISATION_SUBS = [
	[/ou/g, 'o'], [/uu/g, 'u'], [/oo/g, 'o'], [/ō/g, 'o'], [/ū/g, 'u'],
	[/([bcdfghjklmnpqrstvwyz])\1/g, '$1'], [/tsu/g, 'tu'], [/shi/g, 'si'],
	[/chi/g, 'ti'], [/ji/g, 'zi'], [/fu/g, 'hu'],
];

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};
}

const letterIdx = (s, r) => {
	const idx = [...s].map((c, i) => (/[a-z]/i.test(c) ? i : -1)).filter(i => i >= 0);
	return idx.length ? idx[Math.floor(r() * idx.length)] : -1;
};

/**
 * Each generator returns a query string, or null if the class does not apply to
 * this name (e.g. no accent to drop). Returning null is important: it is how we
 * measure how many names are even EXPOSED to each hazard.
 */
export const CLASSES = {
	'A. dropped diacritic': (n) => {
		const d = n.normalize('NFD');
		if (!/\p{M}/u.test(d)) return null;
		return d.replace(/\p{M}/gu, '');
	},

	'B. untypeable symbol dropped': (n) => {
		if (!/[Ͱ-Ͽ -➿®©]/.test(n)) return null;
		return n.replace(/[Ͱ-Ͽ -➿®©]/g, '').replace(/\s+/g, ' ').trim();
	},

	'C. punctuation deleted': (n) => {
		if (!/[^\p{L}\p{N}\s]/u.test(n)) return null;
		return n.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
	},

	'D. punctuation -> space': (n) => {
		if (!/[^\p{L}\p{N}\s]/u.test(n)) return null;
		return n.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
	},

	'E. straight -> curly apostrophe': (n) => {
		if (!n.includes("'")) return null;
		return n.replace(/'/g, '’');
	},

	'F. transposition (1 swap)': (n, r) => {
		const i = letterIdx(n, r);
		if (i < 0 || i + 1 >= n.length || !/[a-z]/i.test(n[i + 1])) return null;
		return n.slice(0, i) + n[i + 1] + n[i] + n.slice(i + 2);
	},

	'G. deletion (1 char)': (n, r) => {
		const i = letterIdx(n, r);
		if (i < 0) return null;
		return n.slice(0, i) + n.slice(i + 1);
	},

	'H. insertion (doubled letter)': (n, r) => {
		const i = letterIdx(n, r);
		if (i < 0) return null;
		return n.slice(0, i) + n[i] + n.slice(i);
	},

	'I. substitution (QWERTY slip)': (n, r) => {
		const i = letterIdx(n, r);
		if (i < 0) return null;
		const lower = n[i].toLowerCase();
		const nb = QWERTY_NEIGHBOURS[lower];
		if (!nb) return null;
		const rep = nb[Math.floor(r() * nb.length)];
		return n.slice(0, i) + (n[i] === lower ? rep : rep.toUpperCase()) + n.slice(i + 1);
	},

	'J. phonetic respelling': (n, r) => {
		const applicable = PHONETIC_SUBS.filter(([re]) => new RegExp(re.source, re.flags).test(n.toLowerCase()));
		if (!applicable.length) return null;
		const [re, to] = applicable[Math.floor(r() * applicable.length)];
		const out = n.toLowerCase().replace(new RegExp(re.source, re.flags), to);
		return out === n.toLowerCase() ? null : out;
	},

	'K. romanisation variant': (n, r) => {
		const applicable = ROMANISATION_SUBS.filter(([re]) => new RegExp(re.source, re.flags).test(n.toLowerCase()));
		if (!applicable.length) return null;
		const [re, to] = applicable[Math.floor(r() * applicable.length)];
		const out = n.toLowerCase().replace(new RegExp(re.source, re.flags), to);
		return out === n.toLowerCase() ? null : out;
	},

	'L. partial recall (token subset)': (n, r) => {
		const t = n.split(/\s+/).filter(Boolean);
		if (t.length < 3) return null;
		const keep = t.filter(() => r() > 0.45);
		return keep.length && keep.length < t.length ? keep.join(' ') : null;
	},

	'M. partial recall, wrong order': (n, r) => {
		const t = n.replace(/,/g, '').split(/\s+/).filter(Boolean);
		if (t.length < 2) return null;
		const shuffled = [...t];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(r() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
		}
		return shuffled.join(' ') === t.join(' ') ? null : shuffled.join(' ');
	},
};

/** Build the query set: for every class, up to `perClass` (name, query) pairs. */
export function buildQueries(names, perClass = 400, seed = 0xC0FFEE) {
	const r = rng(seed);
	const out = {};
	for (const [cls, gen] of Object.entries(CLASSES)) {
		const pairs = [];
		let exposed = 0;
		// Walk the whole corpus in a fixed pseudo-random order so the sample is not
		// alphabetically biased, and stop once we have enough.
		const order = names.map((n, i) => [n, i]).sort((a, b) => ((a[1] * 2654435761) % 1e9) - ((b[1] * 2654435761) % 1e9));
		for (const [name] of order) {
			const q = gen(name, r);
			if (q === null || q === name) continue;
			exposed++;
			if (pairs.length < perClass) pairs.push({ name, query: q });
		}
		out[cls] = { pairs, exposedCount: exposed, exposedShare: exposed / names.length };
	}
	return out;
}
