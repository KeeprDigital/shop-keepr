/**
 * Runs the reprice sweep inline against the local D1 (spec §6, _The
 * sweep_): the same chunks the queue consumer runs in production, driven
 * from Node, since `pnpm dev` has no queue consumer. Drains every job
 * queued or running, or asks for a full one first with `--request`.
 *
 *   pnpm reprice:sweep             drain what is queued
 *   pnpm reprice:sweep --request   queue a full reprice, then drain it
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { jiti, withLocalBindings } from './local-d1.mjs';

const { values } = parseArgs({ options: { request: { type: 'boolean', default: false } } });

const { createDb } = await jiti.import('../server/db/client.ts');
const { drainSweep, readRepriceProgress, requestSweep } = await jiti.import('../server/pricing/sweep.ts');

await withLocalBindings(async (env) => {
	const db = createDb(env.DB);
	const inline = { send: async () => {} };
	if (values.request) {
		const { sweepId, folded } = await requestSweep(db, inline, { reason: 'manual', games: null, watermark: false });
		console.log(`${folded ? 'folded into' : 'queued'} sweep ${sweepId}`);
	}
	for (;;) {
		const progress = await readRepriceProgress(db);
		if (!progress || (progress.status !== 'queued' && progress.status !== 'running')) {
			console.log(progress ? `nothing queued; last sweep ${progress.id} ${progress.status} (${progress.done}/${progress.total})` : 'no sweep has ever run');
			return;
		}
		const outcome = await drainSweep(db, { sweepId: progress.id });
		console.log(`sweep ${outcome.sweepId} ${outcome.status}: ${outcome.done}/${outcome.total} SKUs`);
	}
}).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
