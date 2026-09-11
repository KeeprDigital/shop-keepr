import type { Db } from '../db/client';
import { eq } from 'drizzle-orm';
import { store } from '../db/schema';
import { apiError } from '../utils/api-error';
import { STORE_ID } from '../utils/store';

export interface Health {
	ok: true;
	store: { id: string; name: string };
	checkedAt: number;
}

/** Proves the Worker can reach D1 by reading the Store row. */
export async function readHealth(db: Db): Promise<Health> {
	const row = await db.query.store.findFirst({
		columns: { id: true, name: true },
		where: eq(store.id, STORE_ID),
	});
	if (!row) {
		throw apiError('INTERNAL', undefined, 'Store row missing; run the migrations');
	}
	return { ok: true, store: row, checkedAt: Date.now() };
}
