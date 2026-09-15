import type { AdjustmentResponse } from '../../../shared/contracts/staff/adjustment';
import { zAdjustmentRequest } from '../../../shared/contracts/staff/adjustment';
import { normaliseLanguage } from '../../../shared/domain/language';
import { staffActor } from '../../ledger/actor';
import { recordAdjustment } from '../../ledger/adjustment';
import { readStoreSettings } from '../../services/store';

/** The Adjust modal's write (spec §8.2): one Adjustment, no POS Reference. */
export default defineEventHandler(async (event): Promise<AdjustmentResponse> => {
	const body = await validateBody(event, zAdjustmentRequest);
	const db = useDb(event);
	const { defaultLanguage } = await readStoreSettings(db);
	let language;
	try {
		language = normaliseLanguage(body.language, defaultLanguage);
	}
	catch {
		throw apiError('VALIDATION_FAILED', { message: `Unknown Language: ${body.language}`, details: { issues: [] } });
	}
	return recordAdjustment(db, { ...body, language }, staffActor(event));
});
