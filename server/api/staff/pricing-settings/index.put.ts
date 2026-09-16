import type { PricingSettingWriteOutcome } from '../../../../shared/contracts/staff/pricing-settings';
import { readBody } from 'h3';
import { useRepriceQueue } from '../../../pricing/queue';
import { writePricingSetting } from '../../../pricing/settings';

/** One setting in one scope, validated by the write path; the sweep it needs is queued before the response (spec §6, _When prices are recomputed_). */
export default defineEventHandler(async (event): Promise<PricingSettingWriteOutcome> => writePricingSetting(useDb(event), await readBody(event), { queue: useRepriceQueue(event) }));
