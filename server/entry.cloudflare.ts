/**
 * The production Worker entry (`nuxt.config.ts`, `$production.nitro.entry`):
 * Nitro's own cloudflare-module handler plus the classes the bindings in
 * `wrangler.jsonc` name and the cron handler its triggers fire. Nitro
 * cannot add named exports to its entry, and a Workflow binding needs its
 * class exported from the Worker.
 */
import nitro from 'nitropack/presets/cloudflare/runtime/cloudflare-module';
import { createDb } from './db/client';
import { reconcileOnHand } from './ledger/reconcile';

export { CatalogueSyncWorkflow } from './catalogue/sync/workflow';

const handler: ExportedHandler<Env> = {
	...nitro,
	/** The hourly reconcile (spec §3, _Reconcile job_): heals `on_hand` from the ledger, logs every heal. */
	async scheduled(controller, env, context) {
		context.waitUntil(reconcileOnHand(createDb(env.DB)));
	},
};

export default handler;
