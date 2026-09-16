import type { PricingSettingsView } from '../../../../shared/contracts/staff/pricing-settings';
import { readPricingSettingsView } from '../../../pricing/settings';

/** Every Pricing Rule in every scope, for Settings › Pricing (spec §6; #63). */
export default defineEventHandler((event): Promise<PricingSettingsView> => readPricingSettingsView(useDb(event)));
