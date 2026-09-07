/**
 * Throwaway spike (issue #19): corpus generator for the Postgres re-evaluation.
 *
 * This is a faithful plain-JS port of `spike/d1-search/seed.ts` — same PRNG,
 * same seeds, same word stock, same counts, same field set. That is the whole
 * point: the FTS numbers in `2026-09-07-d1-search-capabilities.md` were taken
 * on this exact corpus, so any Postgres number measured here is comparable to
 * a D1 number row-for-row rather than "roughly similar workload".
 *
 * Emits TSV for `COPY`, which is Postgres's bulk path.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'data');

const GAME_SYSTEM_COUNTS = [
	['magic', 110_000],
	['pokemon', 20_000],
	['yugioh', 13_000],
	['lorcana', 4_000],
	['onepiece', 3_000],
];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ADJECTIVES = [
	'Ancient', 'Blazing', 'Crimson', 'Dread', 'Eternal', 'Fabled', 'Ghostly', 'Hallowed',
	'Infernal', 'Jagged', 'Keen', 'Lurking', 'Molten', 'Nimble', 'Obsidian', 'Primeval',
	'Quicksilver', 'Radiant', 'Sundered', 'Thundering', 'Umbral', 'Verdant', 'Wrathful', 'Zealous',
	'Gilded', 'Hollow', 'Iron', 'Sacred', 'Twilight', 'Withered',
];

const NOUNS = [
	'Archon', 'Basilisk', 'Cenotaph', 'Drake', 'Elemental', 'Familiar', 'Golem', 'Herald',
	'Idol', 'Juggernaut', 'Knight', 'Lantern', 'Mystic', 'Nomad', 'Oracle', 'Phoenix',
	'Quarry', 'Revenant', 'Sentinel', 'Titan', 'Usher', 'Vanguard', 'Warden', 'Yeoman',
	'Zealot', 'Bastion', 'Chalice', 'Dominion', 'Effigy', 'Fetish',
];

const SUFFIXES = [
	'', '', '', '', ' of the Wastes', ' of Ruin', ' of the Deep', ', First of Her Name',
	' of Thorns', ' of the Ninth Circle', ' Reborn', ' Unbound', ' of Storms',
];

const MAGIC_RARITIES = ['common', 'common', 'common', 'uncommon', 'uncommon', 'rare', 'mythic'];
const POKEMON_RARITIES = ['common', 'common', 'uncommon', 'rare', 'rare-holo', 'ultra-rare'];
const YUGIOH_RARITIES = ['common', 'common', 'rare', 'super-rare', 'ultra-rare', 'secret-rare'];

const COLOUR_IDENTITIES = ['W', 'U', 'B', 'R', 'G', 'WU', 'UB', 'BR', 'RG', 'GW', 'WB', 'UR', 'BG', 'RW', 'GU', 'WUBRG', ''];
const FINISHES = ['nonfoil', 'nonfoil', 'nonfoil', 'foil', 'etched'];
const LANGUAGES = ['en', 'en', 'en', 'en', 'en', 'en', 'en', 'en', 'ja', 'de'];

const MAGIC_TYPES = [
	'Creature — Human Soldier', 'Creature — Elf Druid', 'Instant', 'Sorcery',
	'Artifact — Equipment', 'Enchantment — Aura', 'Land', 'Legendary Creature — Dragon',
	'Planeswalker — Jace', 'Creature — Zombie Wizard', 'Artifact Creature — Golem',
];
const POKEMON_TYPES = ['Pokémon — Basic', 'Pokémon — Stage 1', 'Pokémon — Stage 2', 'Trainer — Item', 'Trainer — Supporter', 'Energy — Basic'];
const YUGIOH_TYPES = ['Effect Monster', 'Normal Monster', 'Spell Card — Quick-Play', 'Trap Card — Continuous', 'XYZ Monster', 'Link Monster'];

function pick(rng, xs) {
	return xs[Math.floor(rng() * xs.length)];
}

function raritiesFor(gameSystem) {
	if (gameSystem === 'pokemon') return POKEMON_RARITIES;
	if (gameSystem === 'yugioh') return YUGIOH_RARITIES;
	return MAGIC_RARITIES;
}

function typesFor(gameSystem) {
	if (gameSystem === 'pokemon') return POKEMON_TYPES;
	if (gameSystem === 'yugioh') return YUGIOH_TYPES;
	return MAGIC_TYPES;
}

function generatePrintings() {
	const rng = mulberry32(0x5EED_1234);
	const out = [];
	let n = 0;

	for (const [gameSystem, count] of GAME_SYSTEM_COUNTS) {
		const rarities = raritiesFor(gameSystem);
		const types = typesFor(gameSystem);
		const setCount = Math.max(20, Math.round(count / 260));

		for (let i = 0; i < count; i++) {
			const setIndex = Math.floor(rng() * setCount);
			const setCode = `${gameSystem.slice(0, 2)}${String(setIndex).padStart(3, '0')}`;
			const name = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}${pick(rng, SUFFIXES)}`;
			const isMagic = gameSystem === 'magic';
			const r = rng();
			const marketPrice = r < 0.7
				? Math.floor(rng() * 60) + 5
				: r < 0.95 ? Math.floor(rng() * 900) + 60 : Math.floor(rng() * 40_000) + 900;

			out.push({
				id: `${gameSystem}-${String(n).padStart(7, '0')}-${Math.floor(rng() * 1e6).toString(36)}`,
				gameSystem,
				name,
				setCode,
				setName: `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)} ${setIndex}`,
				collectorNumber: String(1 + Math.floor(rng() * 400)),
				rarity: pick(rng, rarities),
				finish: pick(rng, FINISHES),
				language: pick(rng, LANGUAGES),
				colourIdentity: isMagic ? pick(rng, COLOUR_IDENTITIES) : null,
				typeLine: pick(rng, types),
				subtype: rng() < 0.6 ? `${pick(rng, NOUNS)} ${pick(rng, NOUNS)}` : null,
				manaValue: isMagic ? Math.floor(rng() * 9) : null,
				marketPrice,
				imageUri: `https://cards.example.com/${gameSystem}/${setCode}/${String(n).padStart(7, '0')}.jpg`,
				releasedAt: 1_100_000_000_000 + Math.floor(rng() * 750_000_000_000),
			});
			n++;
		}
	}

	return out;
}

const CONDITIONS = ['NM', 'NM', 'NM', 'LP', 'MP', 'HP', 'DMG'];

function generateStock(printings, skuCount, storeId) {
	const rng = mulberry32(0xF00D_9876);
	const seen = new Set();
	const out = [];

	while (out.length < skuCount) {
		const p = printings[Math.floor(rng() * printings.length)];
		const condition = pick(rng, CONDITIONS);
		const key = `${p.id}|${condition}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const sellPrice = Math.max(5, Math.round(p.marketPrice * (0.9 + rng() * 0.5)));
		out.push({
			storeId,
			printingId: p.id,
			condition,
			quantity: rng() < 0.12 ? 0 : 1 + Math.floor(rng() * 8),
			sellPrice,
			buyPrice: Math.max(1, Math.round(sellPrice * 0.4)),
		});
	}

	return out;
}

/** TSV cell: NULL is `\N`, and tab/newline/backslash must be escaped. */
function cell(v) {
	if (v === null || v === undefined) return '\\N';
	if (typeof v === 'number') return String(v);
	return v.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function tsv(rows, cols) {
	return `${rows.map(r => cols.map(c => cell(r[c])).join('\t')).join('\n')}\n`;
}

mkdirSync(OUT, { recursive: true });

const printings = generatePrintings();
writeFileSync(join(OUT, 'printings.tsv'), tsv(printings, [
	'id', 'gameSystem', 'name', 'setCode', 'setName', 'collectorNumber', 'rarity',
	'finish', 'language', 'colourIdentity', 'typeLine', 'subtype', 'manaValue',
	'marketPrice', 'imageUri', 'releasedAt',
]));

const STOCK_COLS = ['storeId', 'printingId', 'condition', 'quantity', 'sellPrice', 'buyPrice'];
// Two stores, matching the D1 spike: one at the volume #6 assumes, one at 10x
// to reproduce the "bad tail" that spike found.
writeFileSync(join(OUT, 'stock_a.tsv'), tsv(generateStock(printings, 4_000, 'store-a'), STOCK_COLS));
writeFileSync(join(OUT, 'stock_b.tsv'), tsv(generateStock(printings, 60_000, 'store-b'), STOCK_COLS));

// Distinct-term count, so the corpus caveat in the D1 doc can be restated here.
const terms = new Set();
for (const p of printings) {
	for (const field of [p.name, p.setName, p.typeLine]) {
		for (const t of String(field).toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (t) terms.add(t);
	}
}

console.log(JSON.stringify({
	printings: printings.length,
	stockA: 4_000,
	stockB: 60_000,
	distinctTermsOverIndexedFields: terms.size,
}, null, 2));
