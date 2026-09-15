import type { PricingSettingWriteOutcome } from '../../../../shared/contracts/staff/pricing-settings';
import { zPricingSettingWrite } from '../../../../shared/contracts/staff/pricing-settings';
import { useRepriceQueue } from '../../../pricing/queue';
import { writePricingSetting } from '../../../pricing/settings';

/** One setting in one scope; the sweep it needs is queued before the response (spec §6, _When prices are recomputed_). */
export default defineEventHandler(async (event): Promise<PricingSettingWriteOutcome> => {
	const body = await validateBody(event, zPricingSettingWrite);
	return writePricingSetting(useDb(event), body, { queue: useRepriceQueue(event) });
});
