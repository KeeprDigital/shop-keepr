import type { ExchangeRateView } from '../../../shared/contracts/staff/exchange-rate';
import { zExchangeRateSetRequest } from '../../../shared/contracts/staff/exchange-rate';
import { setExchangeRateManually } from '../../fx/exchange-rate';
import { staffActor } from '../../ledger/actor';

/** **Set manually** on the System page (spec §8.2; ADR 0003): a step whatever the threshold, recorded with the session that made it. */
export default defineEventHandler(async (event): Promise<ExchangeRateView> => {
	const body = await validateBody(event, zExchangeRateSetRequest);
	const { sessionId } = staffActor(event);
	return setExchangeRateManually(useDb(event), { ...body, sessionId });
});
