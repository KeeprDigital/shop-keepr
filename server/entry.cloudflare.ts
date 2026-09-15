/**
 * The production Worker entry (`nuxt.config.ts`, `$production.nitro.entry`):
 * Nitro's own cloudflare-module handler plus the classes the bindings in
 * `wrangler.jsonc` name and the cron handler its triggers fire. Nitro
 * cannot add named exports to its entry, and a Workflow binding needs its
 * class exported from the Worker.
 */
import nitro from 'nitropack/presets/cloudflare/runtime/cloudflare-module';
import { createDb } from './db/client';
import { refreshExchangeRates } from './fx/exchange-rate';
import { createFrankfurterRates } from './fx/frankfurter';
import { reconcileOnHand } from './ledger/reconcile';

export { CatalogueSyncWorkflow } from './catalogue/sync/workflow';

const handler: ExportedHandler<Env> = {
	...nitro,
	/**
	 * Hourly: the reconcile (spec §3, _Reconcile job_) heals `on_hand` from
	 * the ledger and logs every heal; then the exchange rate is fetched and
	 * judged against the one in force (ADR 0003), stepping only past the
	 * threshold. Each is its own job: one failing never stops the other.
	 */
	async scheduled(_controller, env) {
		const db = createDb(env.DB);
		const results = await Promise.allSettled([
			reconcileOnHand(db),
			refreshExchangeRates(db, { source: createFrankfurterRates({ fetch: globalThis.fetch.bind(globalThis) }) }),
		]);
		for (const result of results) {
			if (result.status === 'rejected') {
				console.error('[cron] a scheduled job failed', result.reason);
			}
		}
	},
};

export default handler;
