/**
 * The production Worker entry (`nuxt.config.ts`, `$production.nitro.entry`):
 * Nitro's own cloudflare-module handler plus the classes the bindings in
 * `wrangler.jsonc` name, the cron handler its triggers fire and the
 * consumer of the reprice queue. Nitro cannot add named exports to its
 * entry, and a Workflow binding needs its class exported from the Worker.
 */
import type { RepriceMessage } from './pricing/sweep';
import nitro from 'nitropack/presets/cloudflare/runtime/cloudflare-module';
import { createDb } from './db/client';
import { refreshExchangeRates } from './fx/exchange-rate';
import { createFrankfurterRates } from './fx/frankfurter';
import { reconcileOnHand } from './ledger/reconcile';
import { repriceQueue } from './pricing/queue';
import { runSweepChunk, wakeStalledSweeps } from './pricing/sweep';

export { CatalogueSyncWorkflow } from './catalogue/sync/workflow';

const handler: ExportedHandler<Env> = {
	...nitro,
	/**
	 * Hourly: the reconcile (spec §3, _Reconcile job_) heals `on_hand` from
	 * the ledger and logs every heal; then the exchange rate is fetched and
	 * judged against the one in force (ADR 0003), stepping only past the
	 * threshold; and a reprice sweep that stalled is woken again. Each is
	 * its own job: one failing never stops the others.
	 */
	async scheduled(_controller, env) {
		const db = createDb(env.DB);
		const queue = repriceQueue(env);
		const results = await Promise.allSettled([
			reconcileOnHand(db),
			refreshExchangeRates(db, { source: createFrankfurterRates({ fetch: globalThis.fetch.bind(globalThis) }), queue }),
			wakeStalledSweeps(db, queue),
		]);
		for (const result of results) {
			if (result.status === 'rejected') {
				console.error('[cron] a scheduled job failed', result.reason);
			}
		}
	},
	/**
	 * The reprice sweep's consumer (spec §6, _The sweep_): one chunk per
	 * message, then the next message, so the job is a chain of short steps
	 * and the store keeps trading while it runs. A chunk that throws has
	 * marked the job failed; the message is retried in case the fault was
	 * transient, and a message for a settled job does nothing.
	 */
	async queue(batch, env) {
		const db = createDb(env.DB);
		const queue = repriceQueue(env);
		for (const message of batch.messages) {
			const { sweepId } = message.body as RepriceMessage;
			try {
				const outcome = await runSweepChunk(db, { sweepId });
				if (!outcome.finished) {
					await queue.send({ sweepId });
				}
				message.ack();
			}
			catch (error) {
				console.error(`[reprice] sweep ${sweepId}: a chunk failed`, error);
				message.retry();
			}
		}
	},
};

export default handler;
