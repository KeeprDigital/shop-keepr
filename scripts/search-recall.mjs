/**
 * Recall of the five-tier cascade on the real card-name corpus (spec
 * §4.3.4, §9: never a generated corpus): the 38,001 names in
 * `spike/typo-search/data/all-card-names.json` are loaded into one search
 * table of an in-memory D1 through the same write side the sync uses, then
 * the spike's thirteen error classes are applied to a seeded sample of
 * names and each query is run through the cascade. A hit is the source
 * name among the rows returned. Per-class recall is a measurement of the
 * mechanism; the weights between classes are nobody's to claim (#25).
 *
 *   node scripts/search-recall.mjs                # 300 names per class
 *   node scripts/search-recall.mjs --sample 1000
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { CLASSES } from '../spike/typo-search/misspellings.mjs';
import { jiti, withLocalBindings } from './local-d1.mjs';

const { values } = parseArgs({ options: { sample: { type: 'string', default: '300' } } });
const SAMPLE = Number(values.sample);

const { searchStatements, SEARCH_INDEXES } = await jiti.import('../server/search/mirror.ts');
const { searchPrintings } = await jiti.import('../server/search/cascade.ts');
const { gameSystem } = await jiti.import('../server/search/games/index.ts');
const { fold } = await jiti.import('../shared/search/name-keys.ts');
const { packRows, tuple } = await jiti.import('../server/db/sql.ts');

const names = JSON.parse(readFileSync(new URL('../spike/typo-search/data/all-card-names.json', import.meta.url), 'utf8'));
const magic = gameSystem('magic');

function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

/** The committed migrations applied to the empty in-memory D1, statement by statement. */
async function migrate(db) {
	const dir = new URL('../server/db/migrations/', import.meta.url);
	const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', dir), 'utf8'));
	for (const { tag } of journal.entries) {
		const sql = readFileSync(new URL(`${tag}.sql`, dir), 'utf8');
		for (const statement of sql.split('--> statement-breakpoint')) {
			if (statement.trim()) {
				await db.prepare(statement).run();
			}
		}
	}
}

/** Every name as a Magic Printing (game scoping does not bear on recall), written the way a sync page writes. */
async function load(db) {
	const records = names.map((name, i) => ({
		kind: 'printing',
		cursor: `c-${String(i).padStart(6, '0')}`,
		game: 'magic',
		id: `prt-${i}`,
		card_id: `card-${i}`,
		name,
		set_code: 'set',
		collector_number: String(i),
		rarity: null,
		withdrawn: false,
		market_price: null,
		market_price_cursor: null,
		attributes: {},
		images: [],
	}));
	const page = 2_000;
	const started = Date.now();
	for (let i = 0; i < records.length; i += page) {
		const slice = records.slice(i, i + page);
		const printingRows = slice.map(r => tuple([r.id, r.card_id, 'magic', r.name, 'set', r.collector_number, null, null, '[]', null, null, null, null, false, r.cursor, 0]));
		const statements = [
			...packRows('INSERT INTO printing (id, card_id, game_system, name, set_code, collector_number, rarity, finish, images, market_price, market_price_currency, market_price_cursor, market_price_updated_at, withdrawn, cursor, synced_at) VALUES ', printingRows, ''),
			...searchStatements('magic', slice, { now: 0 }),
		];
		await db.batch(statements.map(sql => db.prepare(sql)));
	}
	await db.batch(SEARCH_INDEXES.map(sql => db.prepare(sql)));
	const tokens = (await db.prepare('SELECT COUNT(DISTINCT token) AS n FROM token_trigram').first()).n;
	const rows = (await db.prepare('SELECT COUNT(*) AS n FROM token_trigram').first()).n;
	console.log(`loaded ${names.length} names, ${tokens} distinct tokens, ${rows} token_trigram rows, in ${Date.now() - started} ms`);
}

await withLocalBindings(async (env) => {
	const db = env.DB.withSession('first-primary');
	await migrate(db);
	await load(db);

	const folded = new Map(names.map((name, i) => [`prt-${i}`, fold(name)]));
	console.log(`\nrecall per error class, ${SAMPLE} names sampled per class (seeded); tier = which tier answered the hits\n`);
	console.log('| class | exposed | recall | exact | nospace | tokens | phonetic | fuzzy | miss-wrong | ms/query |');
	console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
	for (const [label, generate] of Object.entries(CLASSES)) {
		const r = rng(0xC0FFEE ^ label.charCodeAt(0));
		const order = [...names.keys()].sort(() => r() - 0.5);
		const tiers = { exact: 0, nospace: 0, tokens: 0, phonetic: 0, fuzzy: 0 };
		let exposed = 0;
		let hits = 0;
		let wrong = 0;
		let elapsed = 0;
		for (const i of order) {
			if (exposed >= SAMPLE) {
				break;
			}
			const name = names[i];
			const query = generate(name, r);
			if (query === null || query.trim() === '' || fold(query) === '') {
				continue;
			}
			exposed += 1;
			const started = performance.now();
			const page = await searchPrintings(db, magic, { q: query, inStock: false, facets: {}, limit: 20, offset: 0 });
			elapsed += performance.now() - started;
			// The same folded name under several Printings counts as found.
			const found = page.rows.some(row => folded.get(row.printingId) === folded.get(`prt-${i}`));
			if (found) {
				hits += 1;
				tiers[page.answeredBy] += 1;
			}
			else if (page.rows.length > 0) {
				wrong += 1;
			}
		}
		const pct = n => `${((100 * n) / Math.max(1, exposed)).toFixed(1)}%`;
		console.log(`| ${label} | ${exposed} | ${pct(hits)} | ${tiers.exact} | ${tiers.nospace} | ${tiers.tokens} | ${tiers.phonetic} | ${tiers.fuzzy} | ${wrong} | ${(elapsed / Math.max(1, exposed)).toFixed(1)} |`);
	}
	console.log('\nmiss-wrong: queries that returned rows without the source name among them (a lower tier answered with something else).');
}, { persist: false });

process.exitCode = 0;
