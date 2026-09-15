import type { RepriceProgress } from '../../../pricing/sweep';
import { readRepriceProgress } from '../../../pricing/sweep';

/** The sweep in flight, or the last one: the progress line on System and in the sidebar footer (spec §6, _The sweep_). */
export default defineEventHandler((event): Promise<RepriceProgress | null> => readRepriceProgress(useDb(event)));
