import { applyD1Migrations, env, reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Every db test starts from the committed migrations applied to an empty
// local D1, the same files `pnpm db:migrate` hands to wrangler. `reset()`
// wipes what the previous test wrote; this pool version has no per-test
// storage isolation of its own.
beforeEach(async () => {
	await reset();
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
