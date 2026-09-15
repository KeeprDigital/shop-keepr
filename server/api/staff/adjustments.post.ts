import type { AdjustmentResponse } from '../../../shared/contracts/staff/adjustment';
import { zAdjustmentRequest } from '../../../shared/contracts/staff/adjustment';
import { staffActor } from '../../ledger/actor';
import { recordAdjustment } from '../../ledger/adjustment';

/** The Adjust modal's write (spec §8.2): one Adjustment, no POS Reference. */
export default defineEventHandler(async (event): Promise<AdjustmentResponse> => {
	const body = await validateBody(event, zAdjustmentRequest);
	return recordAdjustment(useDb(event), body, staffActor(event));
});
