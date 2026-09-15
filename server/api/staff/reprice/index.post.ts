import { useRepriceQueue } from '../../../pricing/queue';
import { requestSweep } from '../../../pricing/sweep';

/** A full reprice on demand, from the System page; folds into any sweep already running. */
export default defineEventHandler(event => requestSweep(useDb(event), useRepriceQueue(event), { reason: 'manual', games: null, watermark: false }));
