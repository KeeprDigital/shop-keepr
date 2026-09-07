/**
 * Throwaway spike (issue #13): deterministic generator for a Catalogue-shaped
 * corpus at the volume issue #6 assumes.
 *
 * Counts and the field set are the point. Names are drawn from real word stock
 * so that FTS5 sees plausible token entropy rather than `card-000123`, and the
 * string lengths are in the range real payloads occupy — the ~400-byte-per-row
 * estimate in #6 is one of the things being measured.
 */

/** Printings per Game System, from #6: ~110k Magic, ~20k Pokémon, ~13k Yu-Gi-Oh, remainder in the tail. */
export const GAME_SYSTEM_COUNTS: ReadonlyArray<readonly [string, number]> = [
	['magic', 110_000],
	['pokemon', 20_000],
	['yugioh', 13_000],
	['lorcana', 4_000],
	['onepiece', 3_000],
];

export const TOTAL_PRINTINGS = GAME_SYSTEM_COUNTS.reduce((n, [, c]) => n + c, 0);

/** Deterministic PRNG so every run measures the same corpus. */
function mulberry32(seed: number): () => number {
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

export interface Printing {
	id: string;
	gameSystem: string;
	name: string;
	setCode: string;
	setName: string;
	collectorNumber: string;
	rarity: string;
	finish: string;
	language: string;
	colourIdentity: string | null;
	typeLine: string;
	subtype: string | null;
	manaValue: number | null;
	marketPrice: number;
	imageUri: string;
	releasedAt: number;
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
	return xs[Math.floor(rng() * xs.length)]!;
}

function raritiesFor(gameSystem: string): readonly string[] {
	if (gameSystem === 'pokemon') return POKEMON_RARITIES;
	if (gameSystem === 'yugioh') return YUGIOH_RARITIES;
	return MAGIC_RARITIES;
}

function typesFor(gameSystem: string): readonly string[] {
	if (gameSystem === 'pokemon') return POKEMON_TYPES;
	if (gameSystem === 'yugioh') return YUGIOH_TYPES;
	return MAGIC_TYPES;
}

/** Generates the whole corpus deterministically. Returns a plain array; ~150k rows fits comfortably in a Worker's heap for a spike. */
export function generatePrintings(): Printing[] {
	const rng = mulberry32(0x5EED_1234);
	const out: Printing[] = [];
	let n = 0;

	for (const [gameSystem, count] of GAME_SYSTEM_COUNTS) {
		const rarities = raritiesFor(gameSystem);
		const types = typesFor(gameSystem);
		// Real catalogues have on the order of hundreds of sets per game.
		const setCount = Math.max(20, Math.round(count / 260));

		for (let i = 0; i < count; i++) {
			const setIndex = Math.floor(rng() * setCount);
			const setCode = `${gameSystem.slice(0, 2)}${String(setIndex).padStart(3, '0')}`;
			const name = `${pick(rng, ADJECTIVES)} ${pick(rng, NOUNS)}${pick(rng, SUFFIXES)}`;
			const isMagic = gameSystem === 'magic';
			// Market price in pence, heavily skewed to cheap cards as a real catalogue is.
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

export interface StockRow {
	storeId: string;
	printingId: string;
	condition: string;
	quantity: number;
	sellPrice: number;
	buyPrice: number;
}

const CONDITIONS = ['NM', 'NM', 'NM', 'LP', 'MP', 'HP', 'DMG'];

/**
 * A single physical store's stock: a few thousand SKUs drawn from the catalogue.
 * Weighted towards Magic, as the store's holdings would be.
 */
export function generateStock(printings: readonly Printing[], skuCount: number, storeId: string): StockRow[] {
	const rng = mulberry32(0xF00D_9876);
	const seen = new Set<string>();
	const out: StockRow[] = [];

	while (out.length < skuCount) {
		const p = printings[Math.floor(rng() * printings.length)]!;
		const condition = pick(rng, CONDITIONS);
		const key = `${p.id}|${condition}`;
		if (seen.has(key)) continue;
		seen.add(key);
		// Sell Price is computed and stored in shop-keepr (#6), not derived at display time.
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

/** SQL string literal, single quotes doubled. Used because D1 caps bound parameters at 100 per statement. */
export function lit(v: string | number | null): string {
	if (v === null) return 'NULL';
	if (typeof v === 'number') return String(v);
	return `'${v.replace(/'/g, '\'\'')}'`;
}

export function printingValues(p: Printing): string {
	return `(${[
		lit(p.id), lit(p.gameSystem), lit(p.name), lit(p.setCode), lit(p.setName),
		lit(p.collectorNumber), lit(p.rarity), lit(p.finish), lit(p.language),
		lit(p.colourIdentity), lit(p.typeLine), lit(p.subtype), lit(p.manaValue),
		lit(p.marketPrice), lit(p.imageUri), lit(p.releasedAt),
	].join(',')})`;
}

export const PRINTING_INSERT_PREFIX
	= 'INSERT INTO catalogue_printing (id,game_system,name,set_code,set_name,collector_number,rarity,finish,language,colour_identity,type_line,subtype,mana_value,market_price,image_uri,released_at) VALUES ';

/**
 * Packs rows into multi-row INSERT statements that stay under `maxBytes`.
 * D1's documented maximum SQL statement length is 100,000 bytes; the headroom
 * is deliberate, because the limit is on bytes and the row text varies.
 */
export function packStatements(prefix: string, values: readonly string[], maxBytes: number): string[] {
	const out: string[] = [];
	let buf = '';
	for (const v of values) {
		const candidate = buf === '' ? prefix + v : `${buf},${v}`;
		if (candidate.length > maxBytes && buf !== '') {
			out.push(`${buf};`);
			buf = prefix + v;
		}
		else {
			buf = candidate;
		}
	}
	if (buf !== '') out.push(`${buf};`);
	return out;
}
