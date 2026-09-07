/**
 * Throwaway spike (issue #4): is a stock reservation atomic on D1 as a single
 * SQL statement, with no interactive transaction and no Durable Object?
 *
 * The statement below is copied verbatim from the contested comment on #4.
 * Do not wire this into the app.
 */

export interface Env {
	DB: D1Database;
}

/** The claim under test, unmodified. */
export const RESERVE_SQL = `
INSERT INTO hold (inventory_item_id, basket_id, quantity, expires_at)
SELECT ?1, ?2, ?3, ?4
WHERE (SELECT on_hand FROM inventory_item WHERE id = ?1)
    - COALESCE((SELECT SUM(quantity) FROM hold
                WHERE inventory_item_id = ?1 AND expires_at > ?5), 0) >= ?3
`;

export interface ReserveInput {
	itemId: string;
	basketId: string;
	quantity: number;
	/** Epoch-ms the created hold expires at. */
	expiresAt: number;
	/** Epoch-ms "now" used to filter out already-expired holds. */
	now: number;
}

export interface ReserveResult {
	granted: boolean;
	changes: number;
	rowsWritten: number;
}

export function reserveStatement(db: D1Database, input: ReserveInput): D1PreparedStatement {
	return db
		.prepare(RESERVE_SQL)
		.bind(input.itemId, input.basketId, input.quantity, input.expiresAt, input.now);
}

export async function reserve(db: D1Database, input: ReserveInput): Promise<ReserveResult> {
	const result = await reserveStatement(db, input).run();
	const changes = result.meta.changes ?? 0;
	return { granted: changes > 0, changes, rowsWritten: result.meta.rows_written ?? 0 };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== '/reserve' || request.method !== 'POST') {
			return new Response('not found', { status: 404 });
		}
		const body = (await request.json()) as Partial<ReserveInput>;
		const now = body.now ?? Date.now();
		const result = await reserve(env.DB, {
			itemId: String(body.itemId),
			basketId: String(body.basketId),
			quantity: Number(body.quantity ?? 1),
			expiresAt: body.expiresAt ?? now + 60_000,
			now,
		});
		return Response.json(result);
	},
} satisfies ExportedHandler<Env>;
