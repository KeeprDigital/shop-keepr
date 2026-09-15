/**
 * The Catalogue sync as a Cloudflare Workflow (spec §5, _Run kinds and
 * execution_): one instance per (kind, Game System) run, one durable step
 * per page returning the next cursor only, retries with exponential backoff
 * per step, resumed by the platform at the last completed page if the
 * instance fails halfway. The class is exported from the Worker by
 * `server/entry.cloudflare.ts` and bound as `CATALOGUE_SYNC`.
 *
 * The Workflow only frames the run: `runCatalogueSync` does the work, so
 * `pnpm catalogue:seed` and the db tests run the same code inline.
 */
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { SyncKind } from '../../../shared/domain/sync-run';
import type { Cursor } from '../generated/types.gen';
import type { StepRunner, SyncOutcome } from './run';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { createCatalogueClient } from '../client';
import { catalogueCredentials } from '../credentials';
import { runCatalogueSync } from './run';

/** The Workflow's input: `{ kind, game, fromCursor }`; omit `fromCursor` to resume from the stored cursor. */
export interface CatalogueSyncParams {
	kind: SyncKind;
	game: string;
	fromCursor?: Cursor;
}

/** A page that fails is retried with exponential backoff before the run is failed. */
const STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
};

export function workflowSteps(step: WorkflowStep): StepRunner {
	// `step.do` demands an RPC-serialisable result; every stage returns plain data.
	const run = step.do.bind(step) as <T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>) => Promise<T>;
	return { do: (name, fn) => run(name, STEP_CONFIG, fn) };
}

export class CatalogueSyncWorkflow extends WorkflowEntrypoint<Env, CatalogueSyncParams> {
	override async run(event: Readonly<WorkflowEvent<CatalogueSyncParams>>, step: WorkflowStep): Promise<SyncOutcome> {
		const { kind, game, fromCursor } = event.payload;
		if (kind !== 'catalogue') {
			// The Market Price walk is #58; it shares this Workflow and its lock.
			throw new Error(`Sync kind "${kind}" is not implemented yet`);
		}
		const client = createCatalogueClient({ fetch: globalThis.fetch.bind(globalThis), ...catalogueCredentials(this.env) });
		return runCatalogueSync({
			db: this.env.DB,
			client,
			game,
			fromCursor,
			steps: workflowSteps(step),
			workflowInstanceId: event.instanceId,
		});
	}
}
