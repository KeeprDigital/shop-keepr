/**
 * The one code path across the Catalogue seam (ADR 0013, spec §5.3). The
 * client takes `{ fetch, baseURL, credential }`: production passes the
 * Worker's `fetch`; tests pass one that serves the committed fixture by
 * path. Every record is validated against the generated Zod schema and
 * handed back with the outcome, so a caller can quarantine a failure with
 * its raw payload and carry on (spec §5.3 item 5).
 */
import type { CatalogueRecord, Cursor, GameCode, MarketPriceRecord, Problem } from './generated/types.gen';
import { z } from 'zod';
import { zCataloguePage, zCatalogueRecord, zMarketPriceRecord, zProblem } from './generated/zod.gen';

export interface CatalogueClientOptions {
	fetch: typeof globalThis.fetch;
	/** The Catalogue API root for this environment, without a trailing slash. */
	baseURL: string;
	/** This environment's API key; shop-keepr is Consumer #1. */
	credential: string;
}

export type ParsedRecord<T>
	= | { ok: true; record: T }
		| { ok: false; raw: unknown; issues: z.core.$ZodIssue[] };

export interface Page<T> {
	records: ParsedRecord<T>[];
	/** Store verbatim; the next walk resumes from here. */
	nextCursor: Cursor;
	hasMore: boolean;
}

/** A request the Catalogue refused, or a response that is not the contract. */
export class CatalogueRequestError extends Error {
	constructor(
		readonly status: number,
		readonly problem: Problem | undefined,
		message: string,
	) {
		super(message);
		this.name = 'CatalogueRequestError';
	}
}

/**
 * The page envelope both walks share, with its records left raw so each is
 * judged on its own.
 */
const zPageEnvelope = zCataloguePage.omit({ records: true }).extend({ records: z.array(z.unknown()) });

export function createCatalogueClient({ fetch, baseURL, credential }: CatalogueClientOptions) {
	async function walk<T>(path: string, cursor: Cursor, zRecord: z.ZodType<T>): Promise<Page<T>> {
		const url = new URL(`${baseURL}${path}`);
		url.searchParams.set('cursor', cursor);
		const response = await fetch(url, {
			headers: { accept: 'application/json', authorization: `Bearer ${credential}` },
		});
		if (!response.ok) {
			const problem = zProblem.safeParse(await response.json().catch(() => undefined)).data;
			throw new CatalogueRequestError(response.status, problem, `Catalogue returned ${response.status} for ${path}`);
		}
		const page = zPageEnvelope.safeParse(await response.json());
		if (!page.success) {
			throw new CatalogueRequestError(response.status, undefined, `Catalogue page for ${path} is not the contract: ${z.prettifyError(page.error)}`);
		}
		return {
			records: page.data.records.map((raw) => {
				const parsed = zRecord.safeParse(raw);
				return parsed.success ? { ok: true, record: parsed.data } : { ok: false, raw, issues: parsed.error.issues };
			}),
			nextCursor: page.data.next_cursor,
			hasMore: page.data.has_more,
		};
	}

	return {
		/** One page of a Game System's Catalogue changes at or after `cursor`; `'0'` walks from the beginning. */
		walkCatalogue: (game: GameCode, cursor: Cursor): Promise<Page<CatalogueRecord>> =>
			walk(`/games/${encodeURIComponent(game)}/catalogue`, cursor, zCatalogueRecord),
		/** One page of a Game System's Market Price movements at or after `cursor`. */
		walkMarketPrices: (game: GameCode, cursor: Cursor): Promise<Page<MarketPriceRecord>> =>
			walk(`/games/${encodeURIComponent(game)}/market-prices`, cursor, zMarketPriceRecord),
	};
}

export type CatalogueClient = ReturnType<typeof createCatalogueClient>;
