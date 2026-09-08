/**
 * Loads the four real card-name corpora and normalises them into one shape.
 *
 * Provenance, per Game System:
 *   Magic     — Scryfall /catalog/card-names, fetched 2026-09-08. Every Magic card
 *               name Scryfall knows. Primary source (Scryfall is the de-facto Magic
 *               data source and publishes this catalogue itself).
 *   Pokemon   — api.pokemontcg.io/v2/cards?select=name, fetched 2026-09-08. A SAMPLE,
 *               not the whole set: the unauthenticated endpoint rate-limits, so only
 *               the pages that returned 200 are included. Card names, not species.
 *   One Piece — en.onepiece-cardgame.com/cardlist/?series=N, Bandai's own official
 *               English card list, all 60 series, scraped 2026-09-08. Primary source.
 *   Riftbound — PROXY. Riot's Data Dragon champion.json (16.17.1), fetched 2026-09-08.
 *               These are League of Legends champion names, NOT Riftbound card names:
 *               no free Riftbound card list was reachable without registering for an
 *               API key, and this spike does not provision accounts. Riftbound cards
 *               are built on this proper-noun vocabulary, so it stands in for the
 *               name SHAPES only. Any per-Game-System figure for Riftbound is a proxy
 *               figure and is labelled as such in the findings.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

function decodeEntities(s) {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&#0?39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/&#x27;/g, "'");
}

export function loadCorpora() {
	const magic = JSON.parse(readFileSync(`${here}data/scryfall-card-names.json`, 'utf8')).data;

	const pokemon = JSON.parse(readFileSync(`${here}data/pokemon-card-names.json`, 'utf8'));

	// Extracted from the scraped HTML by `fetch-data.sh`; the raw 14 MB of HTML is
	// not committed. decodeEntities is retained because it is what produced the file.
	void decodeEntities;
	const onePiece = JSON.parse(readFileSync(`${here}data/one-piece-card-names.json`, 'utf8'));

	const riftbound = JSON.parse(readFileSync(`${here}data/riot-champion-names.json`, 'utf8'));

	return {
		magic: { name: 'Magic', names: magic, provenance: 'Scryfall catalog/card-names (complete)' },
		pokemon: { name: 'Pokemon', names: pokemon, provenance: 'pokemontcg.io /v2/cards (sample)' },
		onePiece: { name: 'One Piece', names: onePiece, provenance: 'Bandai official card list (complete)' },
		riftbound: { name: 'Riftbound', names: riftbound, provenance: 'Riot Data Dragon champions (PROXY)' },
	};
}

/** All names across all four, deduplicated. */
export function allNames(corpora) {
	return [...new Set(Object.values(corpora).flatMap(c => c.names))];
}
