/**
 * The reprice Queue binding behind the `RepriceQueue` seam (spec §2: a
 * Queue for the pricing sweep). Production sends the wake-up through the
 * binding `wrangler.jsonc` names; a test hands the sweep a list. When the
 * binding is absent (a dev server without the queue), the job row still
 * lands and the warning says the consumer will not run until something
 * wakes it, which `pnpm reprice:sweep` does by hand.
 */
import type { H3Event } from 'h3';
import type { RepriceMessage, RepriceQueue } from './sweep';

export function repriceQueue(env: Pick<Env, 'REPRICE'> | undefined): RepriceQueue {
	const binding = env?.REPRICE;
	if (!binding) {
		return {
			async send(message: RepriceMessage) {
				console.warn(`[reprice] no REPRICE queue binding; sweep ${message.sweepId} is queued in D1 and waits for pnpm reprice:sweep`);
			},
		};
	}
	return {
		async send(message: RepriceMessage) {
			await binding.send(message);
		},
	};
}

/** The request's reprice queue, from the Cloudflare bindings Nitro attaches. */
export function useRepriceQueue(event: H3Event): RepriceQueue {
	return repriceQueue(event.context.cloudflare?.env);
}
