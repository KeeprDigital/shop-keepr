/**
 * The five-tier cascade (spec §4.3; ADR 0012): folded exact → space-free
 * exact → FTS5 token-AND → Double Metaphone token-AND → per-token trigram
 * resolve of the tokens the vocabulary does not know, then AND. Every
 * tier is game-scoped, filtered by the same in-stock and Facet predicates,
 * and issued together as one `batch()` (spec §4.3.6): a tier that misses
 * costs no rows and the round trip is paid once. The Worker takes the
 * first non-empty result. Ranking within a tier is FTS5's `rank` where
 * there is one, then name, set and number; every measured figure is
 * recall, and a scoring function in D1 is the fix if ordering disappoints.
 */
import type { AnsweredBy, SearchQuery, SearchRow, SearchTier } from '../../shared/contracts/staff/search';
import type { D1Client } from '../db/client';
import type { GameSystemModule } from './games';
import { fold, foldNoSpace, foldTokens, metaphoneToken, tokenTrigrams } from '../../shared/search/name-keys';
import { literal } from '../db/sql';
import { STORE_ID } from '../utils/store';

/** One search's input: the contract's query with every default applied, minus the game the module already names. */
export type CascadeInput = Omit<Required<SearchQuery>, 'game'>;

export interface TierStatement {
	tier: SearchTier | 'browse';
	sql: string;
}

/**
 * A token this short has too few trigrams to tell a slip from a different
 * word (17.3% of real tokens are ≤ 3 characters, spec §4.3.4, Open); it
 * is matched as typed.
 */
export const MIN_FUZZ_LENGTH = 4;

/** Candidate tokens per failed query token, by shared-trigram count (spec §4.3.4). */
export const FUZZ_CANDIDATES = 10;

/**
 * A candidate must share at least this fraction of the query token's
 * trigrams. One edit in a token breaks at most four of its `len + 2`
 * trigrams, so a third keeps every single slip from four letters up and
 * drops the tokens that share one trigram by coincidence, which is what
 * made a nonsense query answer with the longest name in the Mirror.
 */
export const MIN_SHARED_TRIGRAMS = 1 / 3;

/** A term no folded name can carry, so a token with no candidates makes the AND fail rather than the parser. */
const NO_MATCH = '"nomatch0sentinel"';

export class UnknownFacet extends Error {
	constructor(readonly facet: string, readonly value?: string) {
		super(value === undefined ? `Facet ${facet} does not exist on this Game System` : `Facet ${facet} has no value ${JSON.stringify(value)}`);
	}
}

const SELECT = `SELECT p.id AS printing_id, p.card_id, p.name, p.set_code, p.collector_number, pr.finish, p.rarity, p.market_price, pr.market_price_currency, p.withdrawn, pr.images,`
	+ ` COALESCE((SELECT SUM(h.on_hand) FROM sku h WHERE h.store_id = ${literal(STORE_ID)} AND h.printing_id = p.id), 0) AS held`;

const NAME_ORDER = 'p.name, p.set_code, p.collector_number';

const IN_STOCK = `EXISTS (SELECT 1 FROM sku s WHERE s.store_id = ${literal(STORE_ID)} AND s.printing_id = p.id AND s.on_hand > 0)`;

/**
 * The statements of one search, in tier order; a single `browse` statement
 * when the query has no name. Tier 3 takes the last token as a prefix, so
 * typeahead answers before the noisier tiers (spec §4.3.3, Open); tier 5
 * does not, since a half-typed token has nothing to fuzz against.
 */
export function cascadeStatements(module: GameSystemModule, input: CascadeInput): TierStatement[] {
	const where = [...facetPredicates(module, input.facets), ...(input.inStock ? [IN_STOCK] : [])];
	const tokens = foldTokens(input.q);
	const page = `LIMIT ${literal(input.limit)} OFFSET ${literal(input.offset)}`;
	const plain = (tier: TierStatement['tier'], predicate: string | null): TierStatement => ({
		tier,
		sql: `${SELECT} FROM ${module.table} p JOIN printing pr ON pr.id = p.id${whereClause([predicate, ...where])} ORDER BY ${NAME_ORDER} ${page}`,
	});
	const matched = (tier: SearchTier, expression: string): TierStatement => ({
		tier,
		sql: `${SELECT} FROM ${module.table}_fts f JOIN ${module.table} p ON p.rowid = f.rowid JOIN printing pr ON pr.id = p.id${whereClause([`${module.table}_fts MATCH ${expression}`, ...where])} ORDER BY f.rank, ${NAME_ORDER} ${page}`,
	});
	if (tokens.length === 0) {
		return [plain('browse', null)];
	}
	return [
		plain('exact', `p.name_folded = ${literal(fold(input.q))}`),
		plain('nospace', `p.name_folded_nospace = ${literal(foldNoSpace(input.q))}`),
		matched('tokens', literal(`name_folded : (${tokens.map((t, i) => (i === tokens.length - 1 ? `${phrase(t)}*` : phrase(t))).join(' AND ')})`)),
		matched('phonetic', literal(`name_metaphone : (${tokens.map(t => phrase(metaphoneToken(t))).join(' AND ')})`)),
		matched('fuzzy', `(SELECT 'name_folded : (' || ${tokens.map(fuzzedToken).join(` || ' AND ' || `)} || ')')`),
	];
}

/** ` WHERE a AND b`, or nothing when there is no predicate (a browse of the whole game). */
function whereClause(predicates: (string | null)[]): string {
	const present = predicates.filter((p): p is string => p !== null);
	return present.length === 0 ? '' : ` WHERE ${present.join(' AND ')}`;
}

/** A folded token as an FTS5 phrase: always quoted, so `and`, `or` and `not` are terms rather than operators. */
function phrase(token: string): string {
	return `"${token}"`;
}

/**
 * The SQL expression for one query token's place in the tier-5 MATCH: the
 * token itself when the vocabulary holds it or it is too short to fuzz,
 * else an OR of its closest vocabulary tokens by shared trigrams, and a
 * term that matches nothing when there are none (an empty MATCH is a
 * parse error, never an empty result).
 */
function fuzzedToken(token: string): string {
	const trigrams = tokenTrigrams(token);
	if (token.length < MIN_FUZZ_LENGTH) {
		return literal(phrase(token));
	}
	const known = `EXISTS (SELECT 1 FROM token_trigram WHERE trigram = ${literal(trigrams[0]!)} AND token = ${literal(token)})`;
	const floor = Math.ceil(trigrams.length * MIN_SHARED_TRIGRAMS);
	const candidates = `SELECT token FROM token_trigram WHERE trigram IN (${trigrams.map(literal).join(',')}) GROUP BY token HAVING COUNT(*) >= ${floor} ORDER BY COUNT(*) DESC LIMIT ${FUZZ_CANDIDATES}`;
	const alternatives = `(SELECT '(' || group_concat('"' || token || '"', ' OR ') || ')' FROM (${candidates}))`;
	return `CASE WHEN ${known} THEN ${literal(phrase(token))} ELSE COALESCE(${alternatives}, ${literal(NO_MATCH)}) END`;
}

/** `set` and `rarity` on every game, then the module's Facets: a text Facet is `IN`, a flag Facet is _contains any_. */
function facetPredicates(module: GameSystemModule, facets: Record<string, string[]>): string[] {
	const predicates: string[] = [];
	for (const [facet, values] of Object.entries(facets)) {
		if (values.length === 0) {
			continue;
		}
		const inList = `IN (${values.map(literal).join(',')})`;
		if (facet === 'set') {
			predicates.push(`p.set_code ${inList}`);
			continue;
		}
		if (facet === 'rarity') {
			predicates.push(`p.rarity ${inList}`);
			continue;
		}
		const declared = module.facets.find(f => f.facet === facet);
		if (!declared) {
			throw new UnknownFacet(facet);
		}
		if (declared.kind === 'text') {
			predicates.push(`p.${declared.column} ${inList}`);
			continue;
		}
		const flags = values.map((value) => {
			const column = declared.columns[value];
			if (!column) {
				throw new UnknownFacet(facet, value);
			}
			return `p.${column} = 1`;
		});
		predicates.push(`(${flags.join(' OR ')})`);
	}
	return predicates;
}

/** The first tier with rows, in the order the statements were issued. */
export function firstNonEmptyTier<T>(statements: readonly TierStatement[], results: readonly { results: T[] }[]): { tier: TierStatement['tier'] | null; rows: T[] } {
	for (const [i, { tier }] of statements.entries()) {
		const rows = results[i]?.results ?? [];
		if (rows.length > 0) {
			return { tier, rows };
		}
	}
	return { tier: null, rows: [] };
}

interface RawRow {
	printing_id: string;
	card_id: string;
	name: string;
	set_code: string;
	collector_number: string | null;
	finish: string | null;
	rarity: string | null;
	market_price: number | null;
	market_price_currency: string | null;
	withdrawn: number;
	images: string;
	held: number;
}

/** One search: every tier as one `batch()`, the first non-empty tier's rows. */
export async function searchPrintings(db: D1Client, module: GameSystemModule, input: CascadeInput): Promise<{ answeredBy: AnsweredBy; rows: SearchRow[] }> {
	const statements = cascadeStatements(module, input);
	const results = await db.batch<RawRow>(statements.map(s => db.prepare(s.sql)));
	const { tier, rows } = firstNonEmptyTier(statements, results);
	return { answeredBy: tier, rows: rows.map(searchRowOf) };
}

function searchRowOf(row: RawRow): SearchRow {
	return {
		printingId: row.printing_id,
		cardId: row.card_id,
		name: row.name,
		setCode: row.set_code,
		collectorNumber: row.collector_number,
		finish: row.finish,
		rarity: row.rarity,
		marketPrice: row.market_price,
		marketPriceCurrency: row.market_price_currency,
		withdrawn: row.withdrawn === 1,
		held: row.held,
		thumbnail: firstThumbnail(row.images),
	};
}

function firstThumbnail(images: string): string | null {
	try {
		const parsed: unknown = JSON.parse(images);
		const first = Array.isArray(parsed) ? (parsed[0] as { thumbnail?: unknown } | undefined) : undefined;
		return typeof first?.thumbnail === 'string' ? first.thumbnail : null;
	}
	catch {
		return null;
	}
}
