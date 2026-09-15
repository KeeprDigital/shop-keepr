import type { ExchangeRateView } from '../../../shared/contracts/staff/exchange-rate';
import { readExchangeRates } from '../../fx/exchange-rate';

/** The System page's FX block (spec §8.2): the rate in force, the last fetch, the step behind it, per Catalogue currency. */
export default defineEventHandler((event): Promise<ExchangeRateView[]> => readExchangeRates(useDb(event)));
