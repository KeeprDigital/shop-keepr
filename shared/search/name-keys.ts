/**
 * The name keys every search column and every query string go through
 * (spec §4.3.1, §4.3.2, §4.3.4; ADR 0012): the fold rule, its space-free
 * twin, the Double Metaphone key and the per-token trigrams. Small and
 * versioned so any Catalogue Consumer can apply the same rule; shop-keepr
 * computes the columns at sync time and would mirror them instead if the
 * Catalogue ever exported them. A change here is a rule change: bump the
 * version and re-seed, since every stored key was computed under the old one.
 */
import { doubleMetaphone } from 'double-metaphone';

export const NAME_KEYS_VERSION = 1;

/**
 * NFKD → strip combining marks → lowercase → delete apostrophes → every
 * other non-alphanumeric run becomes one space → trim → NFC. NFKD, not
 * NFD, so an untypeable symbol (`◇`, `★`, `♀`, `®`) decomposes to nothing
 * and falls out, and a full-width letter becomes the letter. Apostrophes
 * are deleted, not spaced: a customer types `Farfetchd`, never
 * `Farfetch d` (worth 57 points of recall, #25). Letters and digits of
 * every script are kept, with two exceptions the measured corpus forced:
 *
 * - the Greek block is dropped, because Pokémon's `δ` species marker is a
 *   letter to Unicode and untypeable to a customer (`Beedrill δ` →
 *   `beedrill`), and no traded game prints a name in Greek;
 * - kana keep their voicing marks (U+3099, U+309A), which NFKD splits off
 *   as combining marks; stripping them would fold `ピ` to `ヒ`, and
 *   leaving them decomposed would split the token under FTS5's tokenizer,
 *   so they are kept and recomposed by the closing NFC.
 */
export function fold(name: string): string {
	return name
		.normalize('NFKD')
		.replaceAll(/(?![\u3099\u309A])\p{M}/gu, '')
		.replaceAll(/\p{Script=Greek}/gu, '')
		.toLowerCase()
		.replaceAll(/['’ʼ‘`]/g, '')
		.replaceAll(/[^\p{L}\p{N}\u3099\u309A]+/gu, ' ')
		.trim()
		.normalize('NFC');
}

/** The fold with its spaces removed: the second exact tier (`farfetchd`, `hooh`). */
export function foldNoSpace(name: string): string {
	return fold(name).replaceAll(' ', '');
}

export function foldTokens(name: string): string[] {
	return fold(name).split(' ').filter(Boolean);
}

/** One Double Metaphone primary key per folded token, joined by a space; a token the algorithm cannot key stands for itself. */
export function metaphoneKey(name: string): string {
	return foldTokens(name).map(metaphoneToken).join(' ');
}

export function metaphoneToken(token: string): string {
	return doubleMetaphone(token)[0] || token;
}

/** The trigrams of one folded token, padded two spaces each side (spec §4.3.4): `  x`, ` xy`, …, `z `, `  ` after; `len + 2` of them. */
export function tokenTrigrams(token: string): string[] {
	if (token.length === 0) {
		return [];
	}
	const padded = `  ${token}  `;
	const out: string[] = [];
	for (let i = 0; i + 3 <= padded.length; i += 1) {
		out.push(padded.slice(i, i + 3));
	}
	return out;
}
