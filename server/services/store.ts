import type { Language } from '../../shared/domain/language';
import type { Db } from '../db/client';
import { eq } from 'drizzle-orm';
import { store } from '../db/schema';
import { apiError } from '../utils/api-error';
import { STORE_ID } from '../utils/store';

export interface StoreSettings {
	/** ISO 4217: the one currency Money is counted in. */
	currency: string;
	/** The Language a SKU takes when staff set none (ADR 0002). */
	defaultLanguage: Language;
}

/** The one Store's settings, as the write paths and the price formatters need them. */
export async function readStoreSettings(db: Db): Promise<StoreSettings> {
	const row = await db.query.store.findFirst({ columns: { currency: true, defaultLanguage: true }, where: eq(store.id, STORE_ID) });
	if (!row) {
		throw apiError('INTERNAL', { message: 'Store row missing; run the migrations' });
	}
	return row;
}
