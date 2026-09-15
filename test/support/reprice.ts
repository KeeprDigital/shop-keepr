import type { RepriceMessage, RepriceQueue } from '../../server/pricing/sweep';

/** A queue that remembers what was sent, for tests to drive the sweep by hand. */
export function memoryQueue(): RepriceQueue & { sent: RepriceMessage[] } {
	const sent: RepriceMessage[] = [];
	return {
		sent,
		async send(message) {
			sent.push(message);
		},
	};
}
