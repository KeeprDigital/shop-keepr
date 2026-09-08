/**
 * Throwaway spike, issue #25 item 1.
 *
 * Emits 150,000 Printings with REAL card names (the 38,001 collected in
 * `spike/typo-search/`, cycled to 150k the way a real Catalogue repeats a name
 * across sets, variations, finishes and languages). Trigram index selectivity is
 * driven entirely by name vocabulary, so #19's generated corpus — 533 distinct
 * terms — cannot answer a pg_trgm question and this one can.
 *
 * Also emits the folded name column measured in `spike/typo-search/`, because the
 * comparison that matters is trigram-similarity-with-LIMIT against the cheap
 * column, not against nothing.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'data');
mkdirSync(OUT, { recursive: true });

const names = JSON.parse(readFileSync(join(HERE, '../typo-search/data/all-card-names.json'), 'utf8'));

const GAMES = [['magic', 110_000], ['pokemon', 20_000], ['onepiece', 13_000], ['riftbound', 4_000], ['tail', 3_000]];
const RARITIES = ['common', 'common', 'common', 'uncommon', 'uncommon', 'rare', 'mythic'];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Identical to `fold()` in spike/typo-search/mechanisms.mjs. */
function fold(s) {
	return s
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/['’ʼ‘`]/g, '')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

const rand = mulberry32(0x5EED1234);
const rows = [];
let i = 0;
for (const [game, count] of GAMES) {
	for (let n = 0; n < count; n++, i++) {
		const name = names[i % names.length];
		rows.push([
			`p-${String(i).padStart(7, '0')}`,
			game,
			name,
			fold(name),
			RARITIES[Math.floor(rand() * RARITIES.length)],
			Math.floor(rand() * 500_00) + 25,
		]);
	}
}

const esc = v => String(v).replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
writeFileSync(join(OUT, 'printings.tsv'), `${rows.map(r => r.map(esc).join('\t')).join('\n')}\n`);

const distinct = new Set(rows.map(r => r[2]));
console.log(`${rows.length} Printings, ${distinct.size} distinct names -> data/printings.tsv`);
