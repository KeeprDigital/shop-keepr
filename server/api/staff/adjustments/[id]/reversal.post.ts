import type { AdjustmentResponse } from '../../../../../shared/contracts/staff/adjustment';
import { zReversalRequest } from '../../../../../shared/contracts/staff/adjustment';
import { staffActor } from '../../../../ledger/actor';
import { reverseAdjustment } from '../../../../ledger/adjustment';

/** Undoes an Adjustment with a compensating entry (ADR 0001). No screen offers it yet: History stays read-only. */
export default defineEventHandler(async (event): Promise<AdjustmentResponse> => {
	const entryId = getRouterParam(event, 'id')!;
	const body = await validateBody(event, zReversalRequest);
	return reverseAdjustment(useDb(event), { entryId, ...body }, staffActor(event));
});
